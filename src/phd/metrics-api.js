function logRequest(httpRequest, startTime) {
    if (httpRequest.request.mediaType === 'video' && httpRequest.request.type === 'MediaSegment') {
        const { request: { index, mediaInfo: { bitrateList }, quality, id } } = httpRequest;

        postMetrics({
            bandwidth_estimate_bps: Math.round(window.PLAYER.getAverageThroughput('video') * 1000),
            fragment_end_time: null,
            fragment_id: index,
            fragment_start_time: startTime,
            request_id: id,
            selected_bitrate_bps: bitrateList[quality].bandwidth,
            session_id: window.SESSION_ID
        });
    }
}

function logResponse(httpRequest, endTime) {
    if (httpRequest.request.mediaType === 'video' && httpRequest.request.type === 'MediaSegment') {
        const { request: { index, mediaInfo: { bitrateList }, quality, id } } = httpRequest;

        postMetrics({
            bandwidth_estimate_bps: Math.round(window.PLAYER.getAverageThroughput('video') * 1000),
            fragment_end_time: endTime,
            fragment_id: index,
            fragment_start_time: null,
            request_id: id,
            selected_bitrate_bps: bitrateList[quality].bandwidth,
            session_id: window.SESSION_ID
        });
    }
}

export { logRequest, logResponse };

function postMetrics(metrics) {
    fetch(`http://${window.SERVER_HOST}:${window.SERVER_PORT}/api/fragment`, {
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify(metrics)
    });
}
