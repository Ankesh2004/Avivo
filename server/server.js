import express from "express";
import cors from "cors";
import { config } from "./config/config.js";
import fs, { stat } from "node:fs";
import https from "node:https";
import fetch from 'node-fetch';
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkers } from "./createWorker.js";
import dotenv from "dotenv";
dotenv.config({path:'../.env'});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const apiKey = process.env.OPENAI_API_KEY;
    
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.post('/api/get-token', async (req, res) => {    
    if (!apiKey) {
        console.log("No diddy");
      return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });
    }
  
    try {
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: 'gpt-4o-mini-realtime-preview',
          },
        }),
      });
  
      if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`OpenAI API failed with status: ${response.status}, body: ${errorBody}`);
      }
  
      const data = await response.json();
      const ephemeralKey = data.value; 
      res.json({ token: ephemeralKey });
    } catch (error) {
      console.error('Error fetching ephemeral key:', error);
      res.status(500).json({ error: 'Failed to fetch ephemeral key from OpenAI.' });
    }
  });

const PORT = config.port || 3001;

// Globals
let workers = null;
let router = null;

// --- Data structures for room management ---
// rooms Map will store room-specific data, including a map of peers for each room.
// rooms.get(roomId) -> { peers: Map<socketId, PeerState> }
// peers:(socket.id, { producerTransport, producer, consumerTransport, consumers: Map<consumerId, consumer> })
const rooms = new Map(); // rooms ---> {peers ---> peerStates}
const socketToRoomMap = new Map(); // quickly get roomId of a socket

function createTransportOptions() {
    return {
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        listenIps: [
            { protocol: "udp", ip: "127.0.0.1" },
            { protocol: "tcp", ip: "127.0.0.1" },
        ],
        // appData: { nat: true },
        // iceServers: [
        //     { urls: "stun:stun.l.google.com:19302" },
        //     // { urls: "turn:your-turn-server.com", username: "user", credential: "pass" }
        // ],
    };
}

function startServer() {
    const options = {
        key: fs.readFileSync(path.join(__dirname, "/config/create-cert-key.pem")),
        cert: fs.readFileSync(path.join(__dirname, "/config/create-cert.pem")),
    };
    const httpsServer = https.createServer(options, app);
    httpsServer.listen(PORT, "0.0.0.0", () => {
        console.log(`Server started on https://0.0.0.0:${PORT}`);
    });

    const io = new Server(httpsServer, {
        cors: { origin: "*" },
    });

    io.on("connect", (socket) => {
        console.log("socket connected:", socket.id);
    
        socket.on('join-room', ({ roomId }) => {
            console.log(`Socket ${socket.id} joining room ${roomId}`);

            // If the room doesn't exist, create it.
            if (!rooms.has(roomId)) {
                rooms.set(roomId, { peers: new Map() });
            }
            const room = rooms.get(roomId);

            // Add the peer to the room.
            room.peers.set(socket.id, {
                producerTransports: new Map(), // kind -> transport
                producers: new Map(),          // kind -> producer
                consumerTransports: new Map(), // kind -> transport
                consumers: new Map(),          // consumerId -> consumer 
            });

            socketToRoomMap.set(socket.id, roomId);
            socket.join(roomId);

            const getProducersForRoom = () => {
                const producerList = [];
                if (!room) return producerList;
                for (const [peerId, peerData] of room.peers.entries()) {
                    if (peerId !== socket.id) {
                        for (const [kind, producer] of peerData.producers.entries()) {
                            producerList.push({ producerId: producer.id, producerSocketId: peerId, kind });
                        }
                    }
                }
                return producerList;
            };

            socket.emit("existing-producers", { roomId, producers: getProducersForRoom() });
        });
    
        socket.on("getRtpCap", (cb) => {
            if (!router) {
                console.warn("Router not ready");
                return cb(null);
            }
            cb(router.rtpCapabilities);
        });
    
        socket.on("create-producer-transport", async ({ kind }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const peerState = rooms.get(roomId)?.peers.get(socket.id);
                if (!peerState) throw new Error("Peer state not found");

                const tr = await router.createWebRtcTransport(createTransportOptions());
                peerState.producerTransports.set(kind, tr);
                cb({
                    id: tr.id,
                    iceParameters: tr.iceParameters,
                    iceCandidates: tr.iceCandidates,
                    dtlsParameters: tr.dtlsParameters,
                });
            } catch (err) {
                console.error("create-producer-transport err:", err);
                cb({ error: "transport-error" });
            }
        });
    
        socket.on("connect-producer-transport", async ({ kind, dtlsParameters }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const state = rooms.get(roomId)?.peers.get(socket.id);
                if (!state) throw new Error("Peer state not found");

                const tr = state.producerTransports.get(kind);
                if (!tr) throw new Error(`no ${kind} producer transport`);

                await tr.connect({dtlsParameters});
                cb("success");
            } catch (err) {
                console.error("connect-producer-transport err:", err);
                cb("error");
            }
        });
    
        socket.on("start-producing", async ({ kind, rtpParameters }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const state = rooms.get(roomId)?.peers.get(socket.id);
                if (!state) throw new Error("Peer state not found");

                const tr = state.producerTransports.get(kind);
                if (!tr) throw new Error(`${kind} transport missing`);
    
                const producer = await tr.produce({ kind, rtpParameters });
                state.producers.set(kind, producer);
    
                producer.on("transportclose", () => {
                    producer.close();
                    state.producers.delete(kind);
                });

                //Broadcast new producer ONLY to peers in the same room.
                socket.to(roomId).emit("new-producer", {
                    roomId, // Include roomId in the payload
                    producer:{
                        producerId: producer.id,
                        producerSocketId: socket.id,
                        kind: producer.kind
                    },
                });
    
                cb({ id: producer.id });
            } catch (err) {
                console.error("start-producing err:", err);
                cb({ error: "produce-error" });
            }
        });
    
        socket.on("create-consumer-transport", async ({ kind }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const peerState = rooms.get(roomId)?.peers.get(socket.id);
                if (!peerState) throw new Error("Peer state not found");
                
                const tr = await router.createWebRtcTransport(createTransportOptions());
                peerState.consumerTransports.set(kind, tr);
                cb({
                    id: tr.id,
                    iceParameters: tr.iceParameters,
                    iceCandidates: tr.iceCandidates,
                    dtlsParameters: tr.dtlsParameters,
                });
            } catch (err) {
                console.error("create-consumer-transport err:", err);
                cb({ error: "transport-error" });
            }
        });
    
        socket.on("connect-consumer-transport", async ({ kind, dtlsParameters }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const state = rooms.get(roomId)?.peers.get(socket.id);
                if (!state) throw new Error("Peer state not found");

                const tr = state.consumerTransports.get(kind);
                if (!tr) throw new Error("no consumer transport");
                await tr.connect({dtlsParameters});
                cb("success");
            } catch (err) {
                console.error("connect-consumer-transport err:", err);
                cb("error");
            }
        });
    
        socket.on("start-consuming", async ({ producerId, clientRtpCapabilities, kind }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const state = rooms.get(roomId)?.peers.get(socket.id);
                if (!state) throw new Error("Peer state not found");

                const tr = state.consumerTransports.get(kind);
                if (!tr) return cb({ error: "no-consumer-transport" });
    
                const consumer = await tr.consume({
                    producerId,
                    rtpCapabilities: clientRtpCapabilities,
                    paused: true,
                });
    
                state.consumers.set(consumer.id, consumer);
    
                consumer.on("producerclose", () => {
                    state.consumers.delete(consumer.id);
                    socket.emit("producer-closed", { roomId, producerId });
                });
    
                cb({
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                });
            } catch (err) {
                console.error("start-consuming err:", err);
                cb({ error: "consume-error", details: err.message });
            }
        });
    
        socket.on("resume-consuming", async ({ consumerId }, cb) => {
            try {
                const roomId = socketToRoomMap.get(socket.id);
                const state = rooms.get(roomId)?.peers.get(socket.id);

                const consumer = state?.consumers.get(consumerId);
                if (!consumer) return cb({ error: "no-consumer" });
                await consumer.resume();
                cb({ ok: true });
            } catch (err) {
                console.error("resume-consuming err:", err);
                cb({ error: "resume-error" });
            }
        });
    
        socket.on("disconnect", async () => {
            console.log("socket disconnect:", socket.id);

            const roomId = socketToRoomMap.get(socket.id);
            if (!roomId) return;

            const room = rooms.get(roomId);
            const state = room?.peers.get(socket.id);
            
            if (state) {
                // Close all mediasoup objects associated with the disconnected peer.
                for (const producer of state.producers.values()) producer.close();
                for (const tr of state.producerTransports.values()) tr.close();
                for (const tr of state.consumerTransports.values()) tr.close();

                // Remove the peer from the room.
                room.peers.delete(socket.id);

                // Notify others in the room that the producers of this peer have closed.
                for (const producer of state.producers.values()) {
                    socket.to(roomId).emit("producer-closed", { roomId, producerId: producer.id });
                }
            }

            // If the room is now empty, delete it to free up memory.
            if (room && room.peers.size === 0) {
                console.log(`Room ${roomId} is now empty, closing it.`);
                rooms.delete(roomId);
            }

            // Clean up the socket-to-room mapping.
            socketToRoomMap.delete(socket.id);
        });

        socket.on('toggle-producer-state', async ({ roomId, kind, paused }) => {
            try {
                const state = rooms.get(roomId)?.peers.get(socket.id);
        
                if (!state) {
                    console.error(`[toggle-producer-state] Peer state not found for socket ${socket.id} in room ${roomId}`);
                    return;
                }
                const producerData = state.producers.get(kind);
                if (!producerData) {
                    console.error(`[toggle-producer-state] Producer of kind "${kind}" not found for socket ${socket.id}`);
                    return;
                }
                const { producer } = producerData;
                if (paused) {
                    await producer.pause();
                } else {
                    await producer.resume();
                }
                // This ensures new participants get the correct mute/video status.
                producerData.paused = paused;
                console.log(`Producer ${producer.id} (${kind}) for socket ${socket.id} state changed to: ${paused ? 'paused' : 'resumed'}`);
        
                // Broadcast the change to EVERYONE ELSE in the room. TODO: handle ui update in frontend
                socket.to(roomId).emit('peer-producer-state-changed', {
                    producerSocketId: socket.id,
                    kind,                   
                    paused           
                });
        
            } catch (err) {
                console.error('Error occurred in toggle-producer-state handler:', err);
            }
        });
    });
    
}

// Init mediasoup
async function initMediaSoup() {
    workers = await createWorkers();
    const worker = workers[0];
    router = await worker.createRouter({
        mediaCodecs: config.routerMediaCodecs,
    });
    console.log("Router created with id : ", router.id);
}

await initMediaSoup();
startServer();
