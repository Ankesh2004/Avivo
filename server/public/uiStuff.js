// UI buttons
const connectButton = document.getElementById('connect')
const deviceButton = document.getElementById('device')
const createProdButton = document.getElementById('create-producer')
const publishButton = document.getElementById('publish')
const createConsButton = document.getElementById('create-consumer')
const consumeButton = document.getElementById('consume')
const disconnectButton = document.getElementById('disconnect')
// other elements
const localVideo = document.getElementById('local-video')
const remoteVideo = document.getElementById('remote-video')

// button listeners
connectButton.addEventListener('click',initConnect)
deviceButton.addEventListener('click',deviceSetup)
createProdButton.addEventListener('click',createProducer)
publishButton.addEventListener('click',publish)
createConsButton.addEventListener('click',createConsume)
consumeButton.addEventListener('click',consume)
disconnectButton.addEventListener('click',disconnect)
