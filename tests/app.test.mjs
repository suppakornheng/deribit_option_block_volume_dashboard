import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../src/js/app.js', import.meta.url), 'utf8');

function createHarness(fetchImplementation = async () => {
    throw new Error('Unexpected network request in unit test');
}) {
    const expiryFilter = { value: 'All' };
    const canvas = { getContext: () => ({}) };
    const fetchStatus = { textContent: '' };
    let animationFrame;
    let fetchCalls = 0;
    const timeoutDelays = [];
    const context = {
        console,
        localStorage: { getItem: () => null, setItem: () => {} },
        requestAnimationFrame: callback => { animationFrame = callback; },
        setTimeout: (callback, delay = 0) => { timeoutDelays.push(delay); callback(); return 1; },
        document: {
            getElementById: id => id === 'expiryFilter' ? expiryFilter : id === 'priceFetchStatus' ? fetchStatus : canvas,
            querySelectorAll: () => []
        },
        fetch: async (...args) => {
            fetchCalls++;
            return fetchImplementation(...args);
        },
        Chart: class {
            constructor(canvasContext, config) {
                this.config = config;
            }
            destroy() {}
        }
    };

    vm.createContext(context);
    vm.runInContext(appSource, context);
    return { context, expiryFilter, fetchStatus, getAnimationFrame: () => animationFrame, getFetchCalls: () => fetchCalls, timeoutDelays };
}

test('number formatter adds thousands separators without changing decimals', () => {
    const { context } = createHarness();
    assert.equal(vm.runInContext("formatNumber(1234, 0)", context), '1,234');
    assert.equal(vm.runInContext("formatNumber(-1234.5, 1)", context), '-1,234.5');
    assert.equal(vm.runInContext("formatNumber(1234567.891, 3)", context), '1,234,567.891');
});

test('chart aggregates global and expiry-filtered volumes without fetching', () => {
    const { context, expiryFilter, getFetchCalls } = createHarness();
    const records = [
        { strike: 100, category: 'Call Buy Blocked', volume: 2, expiry: '01JAN27' },
        { strike: 100, category: 'Call Buy Blocked', volume: 3, expiry: '02JAN27' },
        { strike: 100, category: 'Put Sell Blocked', volume: 4, expiry: '01JAN27' }
    ];
    vm.runInContext(`globalDataset = ${JSON.stringify(records)}; renderChart();`, context);

    let chartData = JSON.parse(vm.runInContext('JSON.stringify(chartInstance.config)', context));
    assert.equal(chartData.data.datasets[0].data[0], -5);
    assert.equal(chartData.data.datasets[3].data[0], 4);
    assert.equal(chartData.options.scales.x.max, 5.25);

    expiryFilter.value = '01JAN27';
    vm.runInContext('renderChart();', context);
    chartData = JSON.parse(vm.runInContext('JSON.stringify(chartInstance.config)', context));
    assert.equal(chartData.data.datasets[0].data[0], -2);
    assert.equal(getFetchCalls(), 0);
});

test('position rendering does not fetch current prices automatically', () => {
    const { context, getFetchCalls } = createHarness();
    vm.runInContext(`rawFetchedRfqs = [{id:'manual-only',amount:1,legs:[{instrument_name:'BTC-28DEC26-100000-C',direction:'buy',ratio:1,price:0.02}]}]; renderStrategiesTable = () => {}; processAndRenderPositions();`, context);
    assert.equal(getFetchCalls(), 0);
});

test('automatic quote queue includes 200 contracts and sorts largest first', () => {
    const { context } = createHarness();
    const strategies = [
        { id: 'below-threshold', legs: [{ size: 199.99 }] },
        { id: 'exact-threshold', legs: [{ size: 150 }, { size: 50 }] },
        { id: 'largest', legs: [{ size: 300 }] },
        { id: 'second-at-threshold', legs: [{ size: 200 }] }
    ];
    vm.runInContext(`parsedStrategies = ${JSON.stringify(strategies)}`, context);

    const queue = JSON.parse(vm.runInContext('JSON.stringify(getLargeStrategyPriceQueue().map(strategy => strategy.id))', context));
    assert.deepEqual(queue, ['largest', 'exact-threshold', 'second-at-threshold']);
});

test('newly loaded positions render by contract size before auto-fetch starts', () => {
    const { context, getAnimationFrame } = createHarness();
    const rfqs = [
        { id: 'small', amount: 100, timestamp: 300, legs: [{ instrument_name: 'BTC-25DEC26-20000-C', ratio: 1, price: 0.02 }] },
        { id: 'largest', amount: 400, timestamp: 200, legs: [{ instrument_name: 'BTC-25DEC26-22000-C', ratio: 1, price: 0.02 }] },
        { id: 'middle', amount: 250, timestamp: 100, legs: [{ instrument_name: 'BTC-25DEC26-24000-P', ratio: 1, price: 0.02 }] }
    ];
    vm.runInContext(`rawFetchedRfqs = ${JSON.stringify(rfqs)}; strategiesSort.by = 'timestampMsec'; strategiesSort.dir = -1; firstRenderIds = []; renderStrategiesTable = () => firstRenderIds.push(getStrategiesForCurrentView().map(strategy => strategy.id)); processAndRenderPositions();`, context);

    const firstRenderIds = JSON.parse(vm.runInContext('JSON.stringify(firstRenderIds[0])', context));
    assert.deepEqual(firstRenderIds, ['largest', 'middle', 'small']);
    assert.equal(vm.runInContext("strategiesSort.by === 'netSize' && strategiesSort.dir === -1", context), true);
    assert.equal(typeof getAnimationFrame(), 'function');
});

test('automatic quote requests run sequentially from largest RFQ to smallest', async () => {
    const requestOrder = [];
    const { context, fetchStatus, getAnimationFrame } = createHarness(async url => {
        requestOrder.push(decodeURIComponent(new URL(url).searchParams.get('instrument_name')));
        return { ok: true, json: async () => ({ result: { last_price: 0.03, index_price: 90000 } }) };
    });
    const strategies = [
        { id: 'small', legs: [{ instrument: 'BTC-28DEC26-100000-C', size: 199, entryPrice: 0.02, side: 'buy' }] },
        { id: 'largest', legs: [{ instrument: 'BTC-28DEC26-110000-C', size: 500, entryPrice: 0.02, side: 'buy' }] },
        { id: 'threshold', legs: [{ instrument: 'BTC-28DEC26-90000-P', size: 200, entryPrice: 0.02, side: 'buy' }] }
    ];
    vm.runInContext(`parsedStrategies = ${JSON.stringify(strategies)}; queueRenderSnapshots = []; renderStrategiesTable = () => queueRenderSnapshots.push(parsedStrategies.map(strategy => strategy.legs.map(leg => leg.currentPrice))); startAutomaticPriceFetch();`, context);

    await getAnimationFrame()();
    assert.deepEqual(requestOrder, [
        'BTC-28DEC26-110000-C',
        'BTC-28DEC26-90000-P'
    ]);
    const renderSnapshots = JSON.parse(vm.runInContext('JSON.stringify(queueRenderSnapshots)', context));
    assert.deepEqual(renderSnapshots.at(-1), [[null], [0.03], [0.03]]);
    assert.equal(fetchStatus.textContent, 'Auto-fetch complete: 2 succeeded, 0 partial, 0 failed.');
});

test('strategy view applies date filters and computes shared net values', () => {
    const { context, expiryFilter } = createHarness();
    const strategies = [
        {
            id: 'inside-range',
            timestamp: Date.parse('2026-11-20T12:00:00Z'),
            legs: [{ entryPrice: 2, size: 3, side: 'buy', expiry: '01JAN27', currentPrice: 3, pnl: 3, pnlUsd: 30, type: 'Call', strike: 100, ratio: 1 }]
        },
        {
            id: 'outside-range',
            timestamp: Date.parse('2026-11-19T12:00:00Z'),
            legs: [{ entryPrice: 4, size: 2, side: 'sell', expiry: '01JAN27', currentPrice: 2, pnl: 4, pnlUsd: 40, type: 'Put', strike: 90, ratio: 1 }]
        }
    ];
    expiryFilter.value = 'All';
    vm.runInContext(`parsedStrategies = ${JSON.stringify(strategies)}; dateFilterFrom = '2026-11-20'; dateFilterTo = '2026-11-20'; strategiesSort.by = 'id'; strategiesSort.dir = 1;`, context);

    const view = JSON.parse(vm.runInContext('JSON.stringify(getStrategiesForCurrentView())', context));
    assert.equal(view.length, 1);
    assert.equal(view[0].id, 'inside-range');
    assert.equal(view[0].netEntry, -6);
    assert.equal(view[0].netCurrent, 9);
    assert.equal(view[0].pnl, 3);
});

test('concurrent quote lookups share a request and later use the cache', async () => {
    const { context, getFetchCalls } = createHarness(async () => ({
        ok: true,
        json: async () => ({ result: { last_price: 0.03, index_price: 90000 } })
    }));
    const instrument = 'BTC-28DEC26-100000-C';
    const source = `fetchCurrentPricesForInstruments([${JSON.stringify(instrument)}])`;

    const [first, second] = await Promise.all([
        vm.runInContext(source, context),
        vm.runInContext(source, context)
    ]);
    assert.equal(getFetchCalls(), 1);
    assert.equal(first[instrument].price, 0.03);
    assert.equal(second[instrument].indexPrice, 90000);

    const cached = await vm.runInContext(source, context);
    assert.equal(getFetchCalls(), 1);
    assert.equal(cached[instrument].price, 0.03);
});

test('ticker requests are serialized with a one-second interval', async () => {
    const requestOrder = [];
    const { context, timeoutDelays } = createHarness(async url => {
        requestOrder.push(new URL(url).searchParams.get('instrument_name'));
        return { ok: true, json: async () => ({ result: { last_price: 0.03, index_price: 90000 } }) };
    });

    await vm.runInContext(`fetchCurrentPricesForInstruments(['BTC-A', 'BTC-B', 'BTC-C'])`, context);

    assert.deepEqual(requestOrder, ['BTC-A', 'BTC-B', 'BTC-C']);
    assert.ok(timeoutDelays.filter(delay => delay === 1000).length >= 2);
});

test('HTTP 400 leaves successful legs visible after the queue rerenders', async () => {
    const requestOrder = [];
    const { context, fetchStatus, getAnimationFrame } = createHarness(async url => {
        const instrument = new URL(url).searchParams.get('instrument_name');
        requestOrder.push(instrument);
        if (instrument === 'BTC-BAD') return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ result: { last_price: 0.03, index_price: 90000 } }) };
    });
    const strategy = {
        id: 'http-400-partial',
        legs: [
            { instrument: 'BTC-GOOD', size: 150, entryPrice: 0.02, side: 'buy', currentPrice: null },
            { instrument: 'BTC-BAD', size: 150, entryPrice: 0.01, side: 'sell', currentPrice: null }
        ]
    };
    vm.runInContext(`parsedStrategies = ${JSON.stringify([strategy])}; queueRenderSnapshots = []; renderStrategiesTable = () => queueRenderSnapshots.push(parsedStrategies.map(item => item.legs.map(leg => leg.currentPrice))); startAutomaticPriceFetch();`, context);

    await getAnimationFrame()();
    const renders = JSON.parse(vm.runInContext('JSON.stringify(queueRenderSnapshots)', context));
    assert.deepEqual(requestOrder, ['BTC-GOOD', 'BTC-BAD']);
    assert.deepEqual(renders.at(-1), [[0.03, null]]);
    assert.equal(fetchStatus.textContent, 'Auto-fetch complete: 0 succeeded, 1 partial, 0 failed.');
});

test('one rejected in-flight quote does not discard successful leg prices', async () => {
    const { context, getFetchCalls } = createHarness(async () => ({
        ok: true,
        json: async () => ({ result: { last_price: 0.03, index_price: 90000 } })
    }));
    const strategy = {
        id: 'partial-quote',
        legs: [
            { instrument: 'BTC-GOOD', size: 2, entryPrice: 0.02, side: 'buy', currentPrice: null },
            { instrument: 'BTC-REJECTED', size: 3, entryPrice: 0.01, side: 'sell', currentPrice: null }
        ]
    };
    vm.runInContext(`parsedStrategies = ${JSON.stringify([strategy])}; priceCache.inflight['BTC-REJECTED'] = Promise.reject(new Error('request rejected'));`, context);

    const succeeded = await vm.runInContext(`fetchStrategyPrices('partial-quote', false)`, context);
    const result = JSON.parse(vm.runInContext('JSON.stringify(parsedStrategies[0])', context));
    assert.equal(succeeded, true);
    assert.equal(result.legs[0].currentPrice, 0.03);
    assert.equal(result.legs[1].currentPrice, null);
    assert.equal(result.priceFetchState, 'partial');
    assert.ok(Math.abs(result.pnl - 0.02) < 1e-12);
    assert.equal(getFetchCalls(), 1);
});
