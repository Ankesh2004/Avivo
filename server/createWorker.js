import os from 'os';
import mediasoup from 'mediasoup';
import { config } from "./config/config";

const totalThreads = os.cpus().length;
export const createWorkers = async()=>new Promise(async(resolve,reject)=>{
    let workers = [];
    for(let i=0;i<totalThreads;i++){
        const worker = await mediasoup.createWorker({
            rtcMinPort: config.workerSettings.rtcMinPort,
            rtcMaxPort: config.workerSettings.rtcMaxPort,
            logLevel: config.workerSettings.logLevel,
            logTags: config.workerSettings.logTags
        })
        worker.on('died',()=>{
            console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]',worker.pid);
            setTimeout(()=>{
            process.exit(1); // if a worker dies, kill the app
            },2000);
        });

        workers.push(worker);
    }
    resolve(workers);
});