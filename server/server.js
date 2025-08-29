import express from "express"
import cors from "cors"
import { config } from "./config/config.js";
import fs from "node:fs";
import https from 'node:https';
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkers } from "./createWorker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// middlerwares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static("public"));

const PORT = config.port || 3030;

// Global variables
let workers = null;
let router = null;

function startServer() {
    // starting a https server
    const options = {
        key: fs.readFileSync(path.join(__dirname,'/config/create-cert-key.pem')),
        cert: fs.readFileSync(path.join(__dirname,'/config/create-cert.pem'))
    }
    const httpsServer = https.createServer(options,app);
    httpsServer.listen(PORT,()=>{
        console.log("Server started !");
    })

    // socket.io server
    const io = new Server(httpsServer,{
        cors: `https://localhost/${PORT}`
    })

    // socketIO event listeners
    io.on('connect',(socket)=>{
        let clientProducerTransport = null;
        let clientProducer = null;
        // Client's Device requests to get RTP Capabilities before connecting to router
        socket.on('getRtpCap', cb=>{
            if(!router){
                console.log("Router not ready");
                return;
            }
            cb(router.rtpCapabilities);
        });

        // create producer transport for the client (client whose socket is this)
        socket.on('create-producer-transport',async cb=>{
            clientProducerTransport = await router.createWebRtcTransport({
                enableUdp:true,
                enableTcp:true,
                preferUdp:true,
                listenInfos:[
                    {
                        protocol: 'udp',
                        ip: '127.0.0.1'
                    },
                    {
                        protocol: 'tcp',
                        ip: '127.0.0.1'
                    }
                ]
            });
            console.log(clientProducerTransport);
            const clientTransportParams = {
                id: clientProducerTransport.id,
                iceParameters: clientProducerTransport.iceParameters,
                iceCandidates: clientProducerTransport.iceCandidates,
                dtlsParameters: clientProducerTransport.dtlsParameters
            }
            cb(clientTransportParams);
        })

        // connect server side transport to the router
        socket.on('connect-transport',async (dtlsParameters,cb)=>{
            try{
                await clientProducerTransport.connect(dtlsParameters);
                cb("success");
            }
            catch(error){
                console.log(error);
                cb("error");
            }
        })

        // start producing
        socket.on('start-producing',async ({kind,rtpParameters},cb)=>{
            try{
                clientProducer = await clientProducerTransport.produce({kind,rtpParameters});
                cb(clientProducer.id);
            }
            catch(error){
                cb("error");
            }
        })
    })
}

// Everything to be initialised to get SFU running
async function initMediaSoup() {
    workers = await createWorkers();
    // testing on 1st worker only for now
    const worker = workers[0];
    router = await worker.createRouter({
        mediaCodecs:config.routerMediaCodecs
    });
    console.log("Router created with id : ",router.id);
}

await initMediaSoup();
startServer();