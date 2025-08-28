// Globals
let socket = null;
let device = null;
let localStream = null;
let producerTransport = null;
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
// 2. Create transport
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
    });
    producerTransport.on('connect',async ({dtlsParameters},callback,errback)=>{
        console.log("Producer transport connected !");
    })
    producerTransport.on('produce',async(parameters,callback,errback)=>{
        console.log('Transport producer event fired!');
    })
    createProdButton.disabled = true;
    publishButton.disabled = true;
};

// 3. Publish transport feed
const publish = async()=>{
    console.log("Publish feed!");
}

// -----------------All socket event listeners-------------------------------
function addSocketListeners(){
    socket.on("connect",()=>{
        connectButton.innerHTML = "Connected";
        deviceButton.disabled = false;
    })
}