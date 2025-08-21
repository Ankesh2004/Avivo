import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import fs from "node:fs";
import https from 'node:https';
import { Server } from "socket.io";
dotenv.config();
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// middlerwares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static("public"));

const PORT = process.env.PORT || 4000;

async function startServer() {
    // starting a https server
    const options = {
        key: fs.readFileSync(path.join(__dirname,'/config/create-cert-key.pem')),
        cert: fs.readFileSync(path.join(__dirname,'/config/create-cert.pem'))
    }
    const httpsServer = https.createServer(options,app);
    httpsServer.listen(4000,()=>{
        console.log("Server started !");
    })

    // socket.io server
    const io = new Server(httpsServer,{
        cors: "https://localhost/4000"
    })
}

startServer();