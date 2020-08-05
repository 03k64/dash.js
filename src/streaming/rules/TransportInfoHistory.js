/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2017, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FactoryMaker from '../../core/FactoryMaker';

function TransportInfoHistory(config) {
    config = config || {};

    const HEADER_KEYS = ['Transport-Info', 'transport-info'];
    const HEADER_KEY_LC = 'transport-info: ';
    const FIELD_PARSERS = {
        cwnd: parseInt,
        dstport: parseInt,
        mss: parseInt,
        rcv_space: parseInt,
        rtt: parseFloat,
        rttvar: parseFloat,
        send_rate: parseFloat,
        ts: Date.parse
    };
    const MAX_MEASUREMENTS_TO_KEEP = 100;
    const SLIDING_WINDOW_SAMPLE_SIZE = 4;

    const settings = config.settings;

    let transportInfoDict,
        transportInfoPort;

    function reset() {
        transportInfoDict = {};
        transportInfoPort = {};
    }

    function setup() {
        reset();
    }

    function sharesNetworkCharacteristics(mediaType, dstPort) {
        return transportInfoPort &&
            transportInfoPort[mediaType] &&
            !isNaN(transportInfoPort[mediaType]) &&
            transportInfoPort[mediaType] === dstPort;
    }

    function isMediaSegmentRequest(httpRequest) {
        return httpRequest.hasOwnProperty('url');
    }

    function parseUnmodified(value) {
        return value;
    }

    function getTransportInfoHeader(headers) {
        if (headers === null || headers === undefined) {
            return;
        }

        // if headers is a CRLF-separated string, look for matching line and return value
        if (typeof headers === 'string') {
            const lcHeaders = headers.toLowerCase();
            const startIx = lcHeaders.indexOf(HEADER_KEY_LC) + HEADER_KEY_LC.length;
            const endIx = lcHeaders.indexOf('\r\n', startIx);

            return headers.substring(startIx, endIx);
        }

        // if headers is an instance of a class implementing the Headers interface returned directly from the fetch API
        if (headers.hasOwnProperty('get') || headers.get) {
            return headers.get('Transport-Info');
        }

        // else 'headers' is an object, look for matching key
        const key = HEADER_KEYS.map(key => headers.hasOwnProperty(key));
        if (key === null || key === undefined) {
            return;
        }

        return headers[key];
    }

    function consumeTransportInfoField(transportInfoEntry, transportInfoField) {
        // Split into key, value pair, handling case that value contains one or more '=' characters
        const [rawKey, ...rawValues] = transportInfoField.trim().split('=');

        const key = rawKey.trim();
        const value = rawValues.join('=').trim();

        const parse = FIELD_PARSERS[key] || parseUnmodified;
        transportInfoEntry[key] = parse(value);

        return transportInfoEntry;
    }

    function parseTransportInfoEntry(transportInfoEntry) {
        let tiEntry = {};

        // Each entry should contain at least two fields, the machine identifier and a timestamp.
        // These and other optional fields are separated by a semi-colon.
        const tiEntryFields = transportInfoEntry.split(';');

        // TODO: properly find machine identifier in tiEntryFields
        tiEntry.machineId = tiEntryFields.shift();
        tiEntry = tiEntryFields.reduce(consumeTransportInfoField, tiEntry);

        if (tiEntry.ts === null || tiEntry.ts === undefined) {
            return;
        }

        // Ensure a dstport is present for determining whether transport-info is related to media
        // segment network flow
        if (tiEntry.dstport === null || tiEntry.dstport === undefined) {
            tiEntry.dstport = NaN;
        }

        return tiEntry;
    }

    function parseTransportInfoHeader(headers) {
        const transportInfo = getTransportInfoHeader(headers);
        if (transportInfo === null || transportInfo === undefined) {
            return;
        }

        // The header may contain multiple entries, separated by a comma, representing measurements
        // taken at multiple distinct timestamps, parse each individually and return an array,
        // filtering those that could not be parsed correctly
        return transportInfo
              .split(',')
              .map(parseTransportInfoEntry)
              .filter(tiEntry => tiEntry !== null && tiEntry !== undefined);
    }

    function push(mediaType, httpRequest) {
        const transportInfo = parseTransportInfoHeader(httpRequest._responseHeaders);
        if (transportInfo === null || transportInfo === undefined) {
            return;
        }

        // Ensure all dictionaries are initialised
        checkSettingsForMediaType(mediaType);

        const tiDstPort = transportInfo.length > 0 ? transportInfo[0].dstport : NaN;

        if (isMediaSegmentRequest(httpRequest)) {
            // Always store transport-info data for media segment requests and update most recently
            // seen port for media type
            transportInfoDict[mediaType].push(...transportInfo);
            transportInfoPort[mediaType] = tiDstPort;
        } else if (sharesNetworkCharacteristics(mediaType, tiDstPort)) {
            // Only store additional transport-info data if flow shares one used for media segment
            // requests
            transportInfoDict[mediaType].push(...transportInfo);
        }

        const date = new Date();
        const mss = settings.get().streaming.maximumSegmentSize;
        transportInfo
            .filter(filterValidThroughputSample)
            .filter(({ dstport }) => sharesNetworkCharacteristics(mediaType, dstport))
            .forEach(({ cwnd, rtt }) => {
                window.transportThroughputHistory.push({
                    quality: httpRequest._quality,
                    value: cwnd * mss * 8 * (1000 / rtt) / 1000000,
                    date,
                    mediaType
                });
            });

        // Ensure all new dictionaries are clamped to maximum size
        transportInfoDict[mediaType] = transportInfoDict[mediaType].slice(-MAX_MEASUREMENTS_TO_KEEP);
    }

    function estimateThroughputFromTransportInfo(transportInfo) {
        const { cwnd, rtt } = transportInfo;
        const mss = transportInfo.mss || settings.get().streaming.maximumSegmentSize;

        return cwnd * mss * 8 * (1000 / rtt);
    }

    function filterValidThroughputSample({ cwnd, rtt }) {
        return cwnd !== null &&
            cwnd !== undefined &&
            !isNaN(cwnd) &&
            rtt !== undefined &&
            rtt !== null &&
            !isNaN(rtt);
    }

    function getAverageThroughput(mediaType) {
        const samples = transportInfoDict[mediaType];
        if (samples === null || samples === undefined || samples.length === 0) {
            return 0;
        }

        const validSamples = samples.filter(filterValidThroughputSample);
        if (validSamples.length === 0) {
            return 0;
        }

        const totalThroughputEstimate = validSamples
            .slice(-SLIDING_WINDOW_SAMPLE_SIZE)
            .map(estimateThroughputFromTransportInfo)
            .reduce((sum, sample) => sum + sample);

        return totalThroughputEstimate / SLIDING_WINDOW_SAMPLE_SIZE / 1000;
    }

    function getAverageLatency(mediaType) {
        const samples = transportInfoDict[mediaType];
        if (samples === null || samples === undefined || samples.length === 0) {
            return 0;
        }

        const validSamples = samples
              .filter(({ rtt }) => rtt !== null && rtt !== undefined && !isNaN(rtt))
              .map(({ rtt }) => rtt);

        if (validSamples.length === 0) {
            return 0;
        }

        return validSamples.slice(-SLIDING_WINDOW_SAMPLE_SIZE).reduce((sum, sample) => sum + sample) / SLIDING_WINDOW_SAMPLE_SIZE;
    }

    function checkSettingsForMediaType(mediaType) {
        transportInfoDict[mediaType] = transportInfoDict[mediaType] || [];
    }

    const instance = {
        push: push,
        getAverageThroughput: getAverageThroughput,
        getAverageLatency: getAverageLatency,
        reset: reset
    };

    setup();

    return instance;
}

TransportInfoHistory.__dashjs_factory_name = 'TransportInfoHistory';
export default FactoryMaker.getClassFactory(TransportInfoHistory);
