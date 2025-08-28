// Globals
let socket = null;
let device = null;
// Start connection to the server
const initConnect = ()=>{
    socket = io("https://localhost:3030");
    connectButton.innerHTML = "Connecting...";
    connectButton.disabled = true;
    addSocketListeners();
}

const deviceSetup = async()=>{
    device = new mediasoupClient.Device();
    // load the device
    const rtpCaps = await socket.emitWithAck('getRtpCap');
    await device.load({routerRtpCapabilities:rtpCaps});
    console.log(device.loaded);
}
// All socket event listeners
function addSocketListeners(){
    socket.on("connect",()=>{
        connectButton.innerHTML = "Connected";
        deviceButton.disabled = false;
    })
}