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

import Constants from '../constants/Constants';
import Debug from '../../core/Debug';
import FactoryMaker from '../../core/FactoryMaker';

function TransportInfoHistory(config) {
    config = config || {};

    const US_PER_S = 1000000;

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

    // sliding window constants
    const MAX_MEASUREMENTS_TO_KEEP = 100;
    const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE = 3;
    const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD = 4;
    const AVERAGE_LATENCY_SAMPLE_AMOUNT = 4;
    const THROUGHPUT_DECREASE_SCALE = 1.3;
    const THROUGHPUT_INCREASE_SCALE = 1.3;

    // EWMA constants
    const EWMA_THROUGHPUT_SLOW_HALF_LIFE_SECONDS = 8;
    const EWMA_THROUGHPUT_FAST_HALF_LIFE_SECONDS = 3;
    const EWMA_LATENCY_SLOW_HALF_LIFE_COUNT = 2;
    const EWMA_LATENCY_FAST_HALF_LIFE_COUNT = 1;
    const EWMA_MEDIA_SEGMENT_HEADER_WEIGHT = 1;
    const EWMA_HEAD_REQUEST_HEADER_WEIGHT = 1;

    const context = this.context;
    const settings = config.settings;

    let ewmaHalfLife,
        ewmaLatencyDict,
        ewmaThroughputDict,
        instance,
        latencyHistory,
        logger,
        throughputHistory,
        transportInfoHistory,
        transportInfoPort;

    function reset() {
        ewmaLatencyDict = {};
        ewmaThroughputDict = {};
        latencyHistory = {};
        throughputHistory = {};
        transportInfoHistory = {};
        transportInfoPort = {};
    }

    function setup() {
        ewmaHalfLife = {
            throughputHalfLife: { fast: EWMA_THROUGHPUT_FAST_HALF_LIFE_SECONDS, slow: EWMA_THROUGHPUT_SLOW_HALF_LIFE_SECONDS },
            latencyHalfLife:    { fast: EWMA_LATENCY_FAST_HALF_LIFE_COUNT,      slow: EWMA_LATENCY_SLOW_HALF_LIFE_COUNT }
        };

        logger = Debug(context).getInstance().getLogger(instance);

        reset();
    }

    function doTrailingTransportInfoRequest(mediaType, url) {
        fetch(url, { method: 'HEAD' })
            .then((response) => {
                push(mediaType, { _responseHeaders: response.headers });
            })
            .catch((err) => {
                logger.debug('doTrailingTransportInfoRequest failed with err: ', err);
            });
    }

    function pushMetricsFromSample(ewmaWeight, mediaType, sample, pushStart) {
        const latency = filterValidLatencySample(sample) ? sample.rtt : NaN;
        const throughput = filterValidThroughputSample(sample) ? estimateThroughputFromTransportInfo(sample) : NaN;

        if (!isNaN(latency)) {
            const latencyMs = latency / 1000;
            latencyHistory[mediaType].push(latencyMs);
            updateEwmaEstimate(ewmaLatencyDict[mediaType], latencyMs, ewmaWeight, ewmaHalfLife.latencyHalfLife);
        }

        if (!isNaN(throughput)) {
            const throughputKbps = throughput / 1000;
            reportRawThroughputMetric(mediaType, throughputKbps, pushStart);
            throughputHistory[mediaType].push(throughputKbps);
            updateEwmaEstimate(ewmaThroughputDict[mediaType], throughputKbps, ewmaWeight, ewmaHalfLife.throughputHalfLife);
        }

        transportInfoHistory[mediaType].push(sample);
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
        const pushStart = new Date();

        const transportInfo = parseTransportInfoHeader(httpRequest._responseHeaders);
        if (transportInfo === null || transportInfo === undefined) {
            return;
        }

        // Ensure all dictionaries are initialised
        checkSettingsForMediaType(mediaType);

        let trailingRequestUrl = null;
        const tiDstPort = transportInfo.length > 0 ? transportInfo[0].dstport : NaN;

        if (isMediaSegmentRequest(httpRequest)) {
            // Always store transport-info data for media segment requests and update most recently
            // seen port for media type
            transportInfo.forEach(sample => pushMetricsFromSample(EWMA_MEDIA_SEGMENT_HEADER_WEIGHT, mediaType, sample, pushStart));
            transportInfoPort[mediaType] = tiDstPort;

            if (settings.get().streaming.useTrailingTransportInfoRequests) {
                trailingRequestUrl = httpRequest.url;
            }
        } else if (sharesNetworkCharacteristics(mediaType, tiDstPort)) {
            // Only store additional transport-info data if flow shares one used for media segment
            // requests
            transportInfo.forEach(sample => pushMetricsFromSample(EWMA_HEAD_REQUEST_HEADER_WEIGHT, mediaType, sample, pushStart));
        }

        // Ensure all new dictionaries are clamped to maximum size
        latencyHistory[mediaType] = latencyHistory[mediaType].slice(-MAX_MEASUREMENTS_TO_KEEP);
        throughputHistory[mediaType] = throughputHistory[mediaType].slice(-MAX_MEASUREMENTS_TO_KEEP);
        transportInfoHistory[mediaType] = transportInfoHistory[mediaType].slice(-MAX_MEASUREMENTS_TO_KEEP);

        if (trailingRequestUrl !== null && trailingRequestUrl !== undefined && trailingRequestUrl.length > 0) {
            doTrailingTransportInfoRequest(mediaType, trailingRequestUrl);
        }
    }

    function estimateThroughputFromTransportInfo(transportInfo) {
        const { cwnd, rtt } = transportInfo;
        const mss = transportInfo.mss || settings.get().streaming.maximumSegmentSize;

        return cwnd * mss * 8 * (US_PER_S / rtt);
    }

    function filterValidThroughputSample({ cwnd, rtt }) {
        return cwnd !== null &&
            cwnd !== undefined &&
            !isNaN(cwnd) &&
            rtt !== undefined &&
            rtt !== null &&
            !isNaN(rtt);
    }

    function filterValidLatencySample({ rtt }) {
        return rtt !== null &&
            rtt !== undefined &&
            !isNaN(rtt);
    }

    function updateEwmaEstimate(ewmaObj, value, weight, halfLife) {
        const fastAlpha = Math.pow(0.5, weight / halfLife.fast);
        ewmaObj.fastEstimate = (1 - fastAlpha) * value + fastAlpha * ewmaObj.fastEstimate;

        const slowAlpha = Math.pow(0.5, weight / halfLife.slow);
        ewmaObj.slowEstimate = (1 - slowAlpha) * value + slowAlpha * ewmaObj.slowEstimate;

        ewmaObj.totalWeight += weight;
    }

    function getAverageEwma(isThroughput, mediaType) {
        const { latencyHalfLife, throughputHalfLife } = ewmaHalfLife;
        const halfLife = isThroughput ? throughputHalfLife : latencyHalfLife;
        const ewmaObj = isThroughput ? ewmaThroughputDict[mediaType] : ewmaLatencyDict[mediaType];

        if (!ewmaObj || ewmaObj.totalWeight <= 0) {
            return NaN;
        }

        const fastEstimate = ewmaObj.fastEstimate / (1 - Math.pow(0.5, ewmaObj.totalWeight / halfLife.fast));
        const slowEstimate = ewmaObj.slowEstimate / (1 - Math.pow(0.5, ewmaObj.totalWeight / halfLife.slow));
        return isThroughput ? Math.min(fastEstimate, slowEstimate) : Math.max(fastEstimate, slowEstimate);
    }

    function getSampleSize(isThroughput, mediaType, isLive) {
        let arr,
            sampleSize;

        if (isThroughput) {
            arr = throughputHistory[mediaType];
            sampleSize = isLive ? AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE : AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD;
        } else {
            arr = latencyHistory[mediaType];
            sampleSize = AVERAGE_LATENCY_SAMPLE_AMOUNT;
        }

        if (!arr) {
            sampleSize = 0;
        } else if (sampleSize >= arr.length) {
            sampleSize = arr.length;
        } else if (isThroughput) {
            // if throughput samples vary a lot, average over a wider sample
            for (let i = 1; i < sampleSize; ++i) {
                const ratio = arr[arr.length - i] / arr[arr.length - i - 1];
                if (ratio >= THROUGHPUT_INCREASE_SCALE || ratio <= 1 / THROUGHPUT_DECREASE_SCALE) {
                    sampleSize += 1;
                    if (sampleSize === arr.length) { // cannot increase sampleSize beyond arr.length
                        break;
                    }
                }
            }
        }

        return sampleSize;
    }

    function getAverageSlidingWindow(isThroughput, mediaType, isDynamic) {
        const sampleSize = getSampleSize(isThroughput, mediaType, isDynamic);
        const history = isThroughput ? throughputHistory : latencyHistory;
        const arr = history[mediaType];

        if (sampleSize === 0 || !arr || arr.length === 0) {
            return NaN;
        }

        return arr
            .slice(-sampleSize)
            .reduce((sum, sample) => sum + sample) / arr.length;
    }

    function getAverage(isThroughput, mediaType, isDynamic) {
        return settings.get().streaming.abr.movingAverageMethod !== Constants.MOVING_AVERAGE_SLIDING_WINDOW ?
            getAverageEwma(isThroughput, mediaType) : getAverageSlidingWindow(isThroughput, mediaType, isDynamic);
    }

    function getAverageLatency(mediaType) {
        return getAverage(false, mediaType);
    }

    function getAverageThroughput(mediaType, isDynamic) {
        return getAverage(true, mediaType, isDynamic);
    }

    function getSafeAverageThroughput(mediaType, isDynamic) {
        let average = getAverageThroughput(mediaType, isDynamic);
        if (!isNaN(average)) {
            average *= settings.get().streaming.abr.bandwidthSafetyFactor;
        }
        return average;
    }

    function reportRawThroughputMetric(mediaType, throughput, time) {
        if ((mediaType.toLowerCase() === 'audio' || mediaType.toLowerCase() === 'video') && window.metricsServerUrl && window.testId) {
            const metricname = mediaType === 'audio' ? 'RawThroughputAudio' : 'RawThroughputVideo';

            const params = {
                testId: window.testId,
                metricname,
                throughput,
                time
            };

            const queryString = Object
                  .entries(params)
                  .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
                  .join('&');

            const url = `${window.metricsServerUrl}?${queryString}`;

            fetch(url).catch(err => logger.error(`Request failed for ${url} :: ${err}`));
        }
    }

    function checkSettingsForMediaType(mediaType) {
        ewmaThroughputDict[mediaType] = ewmaThroughputDict[mediaType] || {fastEstimate: 0, slowEstimate: 0, totalWeight: 0};
        ewmaLatencyDict[mediaType] = ewmaLatencyDict[mediaType] || {fastEstimate: 0, slowEstimate: 0, totalWeight: 0};
        latencyHistory[mediaType] = latencyHistory[mediaType] || [];
        throughputHistory[mediaType] = throughputHistory[mediaType] || [];
        transportInfoHistory[mediaType] = transportInfoHistory[mediaType] || [];
    }

    instance = {
        push: push,
        getAverageLatency: getAverageLatency,
        getAverageThroughput: getAverageThroughput,
        getSafeAverageThroughput: getSafeAverageThroughput,
        reset: reset
    };

    setup();

    return instance;
}

TransportInfoHistory.__dashjs_factory_name = 'TransportInfoHistory';
export default FactoryMaker.getClassFactory(TransportInfoHistory);
