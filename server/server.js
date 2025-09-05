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

// peers map to store per-socket state
// peers.set(socket.id, { producerTransport, producer, consumerTransport, consumers: Map<consumerId, consumer> })
const peers = new Map();

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
    
        // initialize peer state
        peers.set(socket.id, {
            producerTransports: new Map(), // kind -> transport
            producers: new Map(),          // kind -> producer
            consumerTransports: new Map(), // kind -> transport
            consumers: new Map(),          // consumerId -> consumer
        });
    
        // helper to get list of current producers (excluding this socket)
        const getAllProducerInfos = () => {
            const arr = [];
            for (const [peerId, pdata] of peers.entries()) {
                for (const [kind, producer] of pdata.producers.entries()) {
                    if (peerId !== socket.id) {
                        arr.push({
                            producerId: producer.id,
                            producerSocketId: peerId,
                            kind,
                        });
                    }
                }
            }
            return arr;
        };
    
        socket.emit("existing-producers", getAllProducerInfos());
    
        socket.on("getRtpCap", (cb) => {
            if (!router) {
                console.warn("Router not ready");
                return cb(null);
            }
            cb(router.rtpCapabilities);
        });
    
        socket.on("create-producer-transport", async ({ kind }, cb) => {
            try {
                const tr = await router.createWebRtcTransport(createTransportOptions());
                peers.get(socket.id).producerTransports.set(kind, tr);
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
                const state = peers.get(socket.id);
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
                const state = peers.get(socket.id);
                const tr = state.producerTransports.get(kind);
                if (!tr) throw new Error(`${kind} transport missing`);
    
                const producer = await tr.produce({ kind, rtpParameters });
                state.producers.set(kind, producer);
    
                producer.on("transportclose", () => {
                    console.log("producer transport closed, producer closing:", producer.id);
                    producer.close();
                    state.producers.delete(kind);
                });
                producer.on("close", () => {
                    state.producers.delete(kind);
                });
    
                socket.broadcast.emit("new-producer", {
                    producerId: producer.id,
                    producerSocketId: socket.id,
                    kind: producer.kind,
                });
    
                cb({ id: producer.id });
            } catch (err) {
                console.error("start-producing err:", err);
                cb({ error: "produce-error" });
            }
        });
    
        socket.on("create-consumer-transport", async ({ kind }, cb) => {
            try {
                const tr = await router.createWebRtcTransport(createTransportOptions());
                peers.get(socket.id).consumerTransports.set(kind, tr);
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
                const state = peers.get(socket.id);
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
                const state = peers.get(socket.id);
                const tr = state.consumerTransports.get(kind);
                if (!tr) return cb({ error: "no-consumer-transport" });
    
                const consumer = await tr.consume({
                    producerId,
                    rtpCapabilities: clientRtpCapabilities,
                    paused: true,
                });
    
                state.consumers.set(consumer.id, consumer);
    
                consumer.on("transportclose", () => {
                    consumer.close();
                    state.consumers.delete(consumer.id);
                });
                consumer.on("producerclose", () => {
                    state.consumers.delete(consumer.id);
                    socket.emit("producer-closed", { producerId });
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
                const state = peers.get(socket.id);
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
            const state = peers.get(socket.id);
            if (state) {
                try {
                    for (const producer of state.producers.values()) {
                        try { producer.close(); } catch {}
                    }
                    for (const tr of state.producerTransports.values()) {
                        try { tr.close(); } catch {}
                    }
                    for (const consumer of state.consumers.values()) {
                        try { consumer.close(); } catch {}
                    }
                    for (const tr of state.consumerTransports.values()) {
                        try { tr.close(); } catch {}
                    }
                } catch (err) {
                    console.error("error cleaning up peer:", err);
                }
                peers.delete(socket.id);
                socket.broadcast.emit("producer-closed", { producerSocketId: socket.id });
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
