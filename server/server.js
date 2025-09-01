import express from "express";
import cors from "cors";
import { config } from "./config/config.js";
import fs from "node:fs";
import https from "node:https";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkers } from "./createWorker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const PORT = config.port || 3030;

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
        listenInfos: [
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
            producerTransport: null,
            producer: null,
            consumerTransport: null,
            consumers: new Map(), // consumerId -> consumer
        });

        // helper to get list of current producers (excluding this socket)
        const getAllProducerInfos = () => {
            const arr = [];
            for (const [peerId, pdata] of peers.entries()) {
                if (pdata.producer && peerId !== socket.id) {
                    arr.push({
                        producerId: pdata.producer.id,
                        producerSocketId: peerId,
                        kind: pdata.producer.kind,
                    });
                }
            }
            return arr;
        };

        // send existing producers to newly connected socket
        socket.emit("existing-producers", getAllProducerInfos());

        // send RTP capabilities to the client
        socket.on("getRtpCap", (cb) => {
            if (!router) {
                console.warn("Router not ready");
                return cb(null);
            }
            cb(router.rtpCapabilities);
        });

        socket.on("create-producer-transport", async (cb) => {
            try {
                const tr = await router.createWebRtcTransport(createTransportOptions());
                peers.get(socket.id).producerTransport = tr;
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

        socket.on("connect-producer-transport", async (dtlsParameters, cb) => {
            try {
                const state = peers.get(socket.id);
                if (!state?.producerTransport) throw new Error("no producer transport");
                await state.producerTransport.connect( dtlsParameters);
                cb("success");
            } catch (err) {
                console.error("connect-producer-transport err:", err);
                cb("error");
            }
        });

        socket.on("start-producing", async ({ kind, rtpParameters }, cb) => {
            try {
                const state = peers.get(socket.id);
                if (!state?.producerTransport) throw new Error("producer transport missing");
                const producer = await state.producerTransport.produce({ kind, rtpParameters });
                state.producer = producer;

                // PRODUCER LISTENERS : When this producer is closed (peer stops), clean it up
                producer.on("transportclose", () => {
                    console.log("producer transport closed, producer closing:", producer.id);
                    producer.close();
                    state.producer = null;
                });
                producer.on("close", () => {
                    state.producer = null;
                });

                // notify other peers about new producer
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

        socket.on("create-consumer-transport", async (cb) => {
            try {
                const tr = await router.createWebRtcTransport(createTransportOptions());
                peers.get(socket.id).consumerTransport = tr;
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

        socket.on("connect-consumer-transport", async (dtlsParameters, cb) => {
            try {
                const state = peers.get(socket.id);
                if (!state?.consumerTransport) throw new Error("no consumer transport");
                await state.consumerTransport.connect( dtlsParameters );
                cb("success");
            } catch (err) {
                console.error("connect-consumer-transport err:", err);
                cb("error");
            }
        });

        // client asks server to create a consumer for a specific producerId
        socket.on("start-consuming", async ({ producerId, clientRtpCapabilities }, cb) => {
            try {
                const state = peers.get(socket.id);

                if (!state?.consumerTransport) {
                    return cb({ error: "no-consumer-transport" });
                }

                // verify router can consume the given producer with the client's caps
                // if (!router.canConsume({ producerId, rtpCapabilities: clientRtpCapabilities })) {
                //     return cb({ error: "cannot-consume" });
                // }
                console.log("AAA:",producerId);
                const consumer = await state.consumerTransport.consume({
                    producerId,
                    rtpCapabilities: clientRtpCapabilities,
                    paused: true, // start paused; client will call resume ( as per mediasoup recommendation )
                });

                // store consumer
                state.consumers.set(consumer.id, consumer);

                // cleanup listeners
                consumer.on("transportclose", () => {
                    consumer.close();
                    state.consumers.delete(consumer.id);
                });
                consumer.on("producerclose", () => {
                    state.consumers.delete(consumer.id);
                    // notify client to remove track
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

        socket.on("get-participant-count", (cb) => {
            cb(peers.size);
        });

        socket.on("disconnect", async () => {
            console.log("socket disconnect:", socket.id);
            const state = peers.get(socket.id);
            if (state) {
                try {
                    // close producers
                    if (state.producer) {
                        try { state.producer.close(); } catch (e) {}
                    }
                    // close producerTransport
                    if (state.producerTransport) {
                        try { state.producerTransport.close(); } catch (e) {}
                    }
                    // close consumers
                    for (const consumer of state.consumers.values()) {
                        try { consumer.close(); } catch (e) {}
                    }
                    // close consumerTransport
                    if (state.consumerTransport) {
                        try { state.consumerTransport.close(); } catch (e) {}
                    }
                } catch (err) {
                    console.error("error cleaning up peer:", err);
                }
                peers.delete(socket.id);
                // let others know producer from this socket is gone
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
