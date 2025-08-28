export const config = {
    port: 3030,
    workerSettings: {
        rtcMinPort: 40000,
        rtcMaxPort: 41000,
        logLevel: 'warn',
        logTags: [
            'info',
            'ice',
            'dtls',
            'rtp',
            'srtp',
            'rtcp'
        ]
    },
    routerMediaCodecs: [
        {
            kind: "audio",
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2
        },
        {
            kind: "video",
            mimeType: "video/VP8",
            clockRate: 90000,
            parameters: {}
        }
    ]
}