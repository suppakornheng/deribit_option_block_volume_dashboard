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
    let fetchCalls = 0;
    const context = {
        console,
        localStorage: { getItem: () => null, setItem: () => {} },
        document: {
            getElementById: id => id === 'expiryFilter' ? expiryFilter : canvas
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
    return { context, expiryFilter, getFetchCalls: () => fetchCalls };
}

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
