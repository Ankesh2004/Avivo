// Globals
let socket = null;
let device = null;
let localStream = null;
let producerTransport = null;
let producer = null;
let consumerTransport = null;
let consumer = null;
// Start connection to the server
const initConnect = ()=>{
    socket = io("https://localhost:3030");
    connectButton.innerHTML = "Connecting...";
    connectButton.disabled = true;
    addSocketListeners();
}
// 1. Setup the device
const deviceSetup = async()=>{
    device = new mediasoupClient.Device();
    // load the device
    await socket.emit('getRtpCap',async(rtpCaps)=>{
        try{
            await device.load({ routerRtpCapabilities: rtpCaps });
            console.log('Device loaded successfully:', device.loaded);

            deviceButton.innerHTML = "Device Ready";
            deviceButton.disabled = true;
            createProdButton.disabled = false;
        }catch(err){
            console.log(err);
            if(err.name === 'UnsupportedError'){
                console.warn("browser not supported");
            }
        }
    });
}
// 2. Create producer transport
const createProducer = async()=>{
    try{
        localStream = await navigator.mediaDevices.getUserMedia({
            audio:true,
            video:true
        })
        localVideo.srcObject = localStream;
    }catch(error){
        console.log("GUM error",error);
    }
    socket.emit('create-producer-transport',async (data)=>{
        console.log(data);
        const {id,iceParameters,iceCandidates,dtlsParameters} = data;
        const transport = device.createSendTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters
        });
        producerTransport = transport;

        producerTransport.on('connect',async ({dtlsParameters},callback,errback)=>{
            console.log("Producer transport connected !",dtlsParameters);
    
            await socket.emit('connect-producer-transport',{dtlsParameters},(res)=>{
                console.log(res);
    
                if(res==="success"){
                    callback(); // must be called after server side transport is being connected to the router
                }
                else{
                    errback();
                }
            });
        })
        producerTransport.on('produce',async(parameters,callback,errback)=>{
            console.log('Transport producer event fired!');

            const {kind,rtpParameters} = parameters;
            await socket.emit('start-producing',{kind,rtpParameters},(res)=>{
                console.log(res);

                if(res==="error"){
                    console.error('Something went wrong when server tried to produce the feed to the router');
                    errback();
                }
                else{
                    callback({id:res});

                    publishButton.disabled = true;
                    createConsButton.disabled = false;
                }
            });
        })
        createProdButton.disabled = true;
        publishButton.disabled = false;
    });
    
};

// 3. Publish transport feed
const publish = async()=>{
    const track = localStream.getVideoTracks()[0];
    producer = await producerTransport.produce({track});
}

// 4. Create consumer transport
const createConsumer = async()=>{
    socket.emit('create-consumer-transport',async (data)=>{
        console.log(data);
        const {id,iceParameters,iceCandidates,dtlsParameters} = data;
        const transport = device.createRecvTransport({
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters
        });
        consumerTransport = transport;
        console.log("Cosumer transport created!")
        consumerTransport.on('connect',async ({dtlsParameters},callback,errback)=>{
            console.log("Consumer transport connected !",dtlsParameters);
    
            await socket.emit('connect-consumer-transport',{dtlsParameters},(res)=>{
                console.log(res);
    
                if(res==="success"){
                    callback(); // must be called after server side transport is being connected to the router
                }
                else{
                    errback();
                }
            });
        })
        createConsButton.disabled = true;
        consumeButton.disabled = false;
    });
    
};

// 5. consume the feed
const consume = async()=>{
    await socket.emit('start-consuming',{clientRtpCapabilities:device.rtpCapabilities},async res=>{
        console.log(res);
        
        if(res==="error"){
            console.error('Something went wrong when server tried to consume the feed from the router');
            return;
        }
        const {id,producerId,kind,rtpParameters} = res;

        consumer = await consumerTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters
        })
        

        await socket.emit('resume-consuming',()=>{
            try{
                const { track } = consumer;
                remoteVideo.srcObject = new MediaStream([track]);
            }catch(error){
                console.log('Error in resuming consumer feed on client side',error);
            }
        })
        // resume the tracks
        await consumer.resume();

        consumeButton.disabled = true;
        disconnectButton.disabled = false;
    });
}
// -----------------All socket event listeners-------------------------------
function addSocketListeners(){
    socket.on("connect",()=>{
        connectButton.innerHTML = "Connected";
        deviceButton.disabled = false;
    })
}