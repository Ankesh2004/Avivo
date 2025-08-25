import express from "express"
import cors from "cors"
import { config } from "./config/config";
import fs from "node:fs";
import https from 'node:https';
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { createWorkers } from "./createWorker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// middlerwares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static("public"));

const PORT = config.port || 4000;

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
}
let workers = null;
// Everything to be initialised to get SFU running
async function initMediaSoup() {
    workers = await createWorkers();

}

startServer();
initMediaSoup();