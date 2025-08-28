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

const PORT = config.port || 4000;

// Global variables
let workers = null;
let router = null;

async function startServer() {
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
        socket.on('getRtpCap', ()=>{
            if(!router){
                console.log("Router not ready");
                return;
            }
            return router.rtpCapabilities;
        });
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

startServer();
initMediaSoup();