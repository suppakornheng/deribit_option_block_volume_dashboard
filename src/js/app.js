let globalDataset = [];
let rawFetchedRfqs = [];
let chartInstance = null;
const payoffChartInstances = new Set();
let selectedAsset = 'BTC';
let isFetchingApi = false;
const AUTO_FETCH_MIN_CONTRACTS = 200;
const PRICE_REQUEST_DELAY_MS = 1000;
let autoFetchLargeStrategiesStarted = false;
let autoFetchGeneration = 0;
// date range filter state (YYYY-MM-DD strings)
let dateFilterFrom = null;
let dateFilterTo = null;

function formatNumber(value, decimals = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    const fixed = number.toFixed(decimals);
    const [integer, fraction] = fixed.split('.');
    const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction == null ? formattedInteger : `${formattedInteger}.${fraction}`;
}

// HELPER: Map Deribit DDMMMYY Expiry String to JavaScript Date objects using UTC boundaries
function parseExpiryToDate(expiryStr) {
    const match = expiryStr.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!match) return new Date(0);

    const day = parseInt(match[1]);
    const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
    const month = months[match[2]] || 0;
    const year = 2000 + parseInt(match[3]);

    // OPTIONSET SPEC: Explicitly anchor contract expiration logic at 08:00:00 UTC
    const expiryUtc = new Date(Date.UTC(year, month, day, 8, 0, 0));
    return expiryUtc;
}

// HELPER: Check if a contract expiry has already passed compared to current UTC epoch
function isContractExpired(expiryStr) {
    const expiryTime = parseExpiryToDate(expiryStr).getTime();
    const currentTime = Date.now();
    return expiryTime < currentTime;
}

// 1. DATA PARSING CORE LOGIC (JSONL Ingestion Engine)
function parseRawJsonLines(rawText) {
    const lines = rawText.split('\n');
    const records = [];
    rawFetchedRfqs = [];

    lines.forEach(line => {
        if (!line.trim()) return;
        try {
            const rfq = JSON.parse(line);
            rawFetchedRfqs.push(rfq);
            const amount = rfq.amount || 0;

            (rfq.legs || []).forEach(leg => {
                const inst = leg.instrument_name || "";
                const match = inst.match(/(BTC|ETH)-([0-9A-Z]+)-(\d+)-([CP])$/);

                if (match) {
                    const expiry = match[2];

                    // SKIP IF CONTRACT ALREADY EXPIRED (PAST 8:00 UTC)
                    if (isContractExpired(expiry)) return;

                    records.push({
                        expiry: expiry,
                        strike: parseInt(match[3]),
                        category: `${match[4] === 'C' ? 'Call' : 'Put'} ${(leg.direction || "buy").toLowerCase().charAt(0).toUpperCase() + (leg.direction || "buy").toLowerCase().slice(1)} Blocked`,
                        volume: parseFloat(amount * (leg.ratio || 1))
                    });
                }
            });
        } catch (err) {}
    });
    return records;
}

// 2. PARSING TARGETED BLOCK RFQ TRADES FROM PUBLIC ENDPOINT
function parseBlockRfqTradesArray(rfqArray, assetTicker) {
    const records = [];

    rfqArray.forEach(rfq => {
        const amount = rfq.amount || 0;

        (rfq.legs || []).forEach(leg => {
            const inst = leg.instrument_name || "";
            const regex = new RegExp(`^${assetTicker}-([0-9A-Z]+)-(\\d+)-([CP])$`);
            const match = inst.match(regex);

            if (match) {
                const expiry = match[1];

                // SKIP IF CONTRACT ALREADY EXPIRED (PAST 8:00 UTC)
                if (isContractExpired(expiry)) return;

                const strike = parseInt(match[2]);
                const type = match[3] === 'C' ? 'Call' : 'Put';
                const direction = (leg.direction || "buy").toLowerCase();
                const formattedDir = direction.charAt(0).toUpperCase() + direction.slice(1);

                records.push({
                    expiry: expiry,
                    strike: strike,
                    category: `${type} ${formattedDir} Blocked`,
                    volume: parseFloat(amount * (leg.ratio || 1))
                });
            }
        });
    });
    return records;
}

function updateExpiryFilterDropdown() {
    const select = document.getElementById('expiryFilter');
    const preservedSelectedValue = select.value;

    select.innerHTML = '<option value="All">All Expiries</option>';

    const uniqueExpiries = [...new Set(globalDataset.map(d => d.expiry))].sort((a, b) => {
        return parseExpiryToDate(a) - parseExpiryToDate(b);
    });

    uniqueExpiries.forEach(exp => {
        const opt = document.createElement('option');
        opt.value = exp; opt.textContent = exp;
        select.appendChild(opt);
    });

    if ([...select.options].some(o => o.value === preservedSelectedValue)) {
        select.value = preservedSelectedValue;
    }
}

function swapScreenToDashboard() {
    document.getElementById('uploadScreen').classList.add('hidden');
    const dash = document.getElementById('dashboardScreen');
    dash.classList.remove('hidden');
    setTimeout(() => dash.classList.remove('opacity-0'), 50);
    // Default to newest-first by timestamp on initial dashboard landing
    if (strategiesSort.by === 'id') {
        strategiesSort.by = 'timestampMsec';
        strategiesSort.dir = -1;
    }
}

function appendApiLog(msg) {
    const logger = document.getElementById('apiLogOutput');
    const stamp = new Date().toTimeString().split(' ')[0];
    logger.innerText += `[${stamp}] ${msg}\n`;
    logger.scrollTop = logger.scrollHeight;
}

// PIPELINE A: LOCAL DATA UPLOAD FILE
function setUploadStatus(message, isError = false) {
    const status = document.getElementById('uploadStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('status-error', isError);
}

function handleFileLoading(event) {
    const file = event.target.files[0];
    if (!file) return;

    resetAutomaticPriceFetch();
    setUploadStatus(`Reading ${file.name}...`);
    const reader = new FileReader();
    reader.onload = function(e) {
        selectedAsset = 'BTC';
        document.getElementById('dashTitleAsset').innerText = selectedAsset;
        globalDataset = parseRawJsonLines(e.target.result);
        if (globalDataset.length === 0) {
            setUploadStatus('No valid unexpired option legs found. Check the JSONL file and try again.', true);
            event.target.value = '';
            return;
        }
        updateExpiryFilterDropdown();
        swapScreenToDashboard();
        renderChart();
        processAndRenderPositions();
        setUploadStatus(`Loaded ${globalDataset.length} active option legs from ${file.name}.`);
        event.target.value = '';
    };
    reader.onerror = function() {
        setUploadStatus(`Could not read ${file.name}. Try another file.`, true);
        event.target.value = '';
    };
    reader.readAsText(file);
}

// PIPELINE B: SEQUENTIAL PAGINATION PARSER ENGINE FOR GET_BLOCK_RFQ_TRADES
async function startLiveApiEngine() {
    if (isFetchingApi) return;
    resetAutomaticPriceFetch();
    isFetchingApi = true;

    const spinner = document.getElementById('apiBtnSpinner');
    const btn = document.getElementById('apiBtnStart');
    const progressPanel = document.getElementById('apiProgressContainer');
    const bar = document.getElementById('apiProgressBar');
    const statusTxt = document.getElementById('apiProgressStatus');
    const countTxt = document.getElementById('apiRecordCount');
    const logger = document.getElementById('apiLogOutput');

    spinner.classList.remove('hidden');
    btn.disabled = true;
    progressPanel.classList.remove('hidden');
    logger.innerText = "";
    bar.style.width = "0%";

    selectedAsset = document.getElementById('apiCurrency').value;
    document.getElementById('dashTitleAsset').innerText = selectedAsset;

    const lookbackDays = parseInt(document.getElementById('apiLookback').value) || 30;
    const cutOffTimestamp = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);

    let parsedRecordsAccumulator = [];
    rawFetchedRfqs = [];
    let continuationToken = "";
    let keepLooping = true;
    let cycleCount = 1;

    appendApiLog(`Targeting ${selectedAsset} Block RFQs back to ${lookbackDays} days ago.`);

    try {
        while (keepLooping) {
            statusTxt.innerText = `Fetching Batch #${cycleCount}...`;

            let url = `https://www.deribit.com/api/v2/public/get_block_rfq_trades?currency=${selectedAsset}`;
            if (continuationToken) {
                url += `&continuation=${encodeURIComponent(continuationToken)}`;
            }

            const response = await fetch(url, { method: 'GET', cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP network anomaly status code: ${response.status}`);

            const payload = await response.json();
            const rawRfqs = payload.result?.block_rfqs || [];
            continuationToken = payload.result?.continuation;

            if (rawRfqs.length === 0) {
                appendApiLog("Hit the edge of the public transaction matrix stream.");
                break;
            }

            rawFetchedRfqs = rawFetchedRfqs.concat(rawRfqs);

            const batchMapped = parseBlockRfqTradesArray(rawRfqs, selectedAsset);
            parsedRecordsAccumulator = parsedRecordsAccumulator.concat(batchMapped);

            const oldestRecordInBatch = rawRfqs[rawRfqs.length - 1];
            countTxt.innerText = `${formatNumber(parsedRecordsAccumulator.length, 0)} active leg records`;

            const spanDistance = Date.now() - cutOffTimestamp;
            const deltaDistance = Date.now() - oldestRecordInBatch.timestamp;
            const computedProgress = Math.min(100, Math.max(5, (deltaDistance / spanDistance) * 100));
            bar.style.width = `${computedProgress}%`;

            appendApiLog(`Parsed batch ${cycleCount} (${rawRfqs.length} RFQs). Oldest: ${new Date(oldestRecordInBatch.timestamp).toLocaleDateString()}`);

            if (oldestRecordInBatch.timestamp < cutOffTimestamp) {
                appendApiLog("Temporal lookback barrier breached safely.");
                bar.style.width = "100%";
                break;
            }

            if (!continuationToken) {
                appendApiLog("No valid continuation sequences remaining.");
                bar.style.width = "100%";
                break;
            }

            cycleCount++;
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        if (parsedRecordsAccumulator.length === 0) {
            alert("No valid unexpired options trades parsed inside specified scope windows.");
        } else {
            globalDataset = parsedRecordsAccumulator;
            updateExpiryFilterDropdown();
            document.getElementById('liveStatusBadge').classList.remove('hidden');
            swapScreenToDashboard();
            renderChart();
            processAndRenderPositions();
        }

    } catch (err) {
        console.error(err);
        appendApiLog(`Fatal Pipeline Fault: ${err.message}`);
        alert(`Engine synchronization anomaly: ${err.message}`);
    } finally {
        spinner.classList.add('hidden');
        btn.disabled = false;
        isFetchingApi = false;
        statusTxt.innerText = "Execution process sequence finalized.";
    }
}

function downloadDatasetAsJsonl() {
    if (rawFetchedRfqs.length === 0) {
        alert("No active internal records in volatile memory arrays to export.");
        return;
    }

    const jsonlContent = rawFetchedRfqs.map(rfq => JSON.stringify(rfq)).join('\n') + '\n';
    const blob = new Blob([jsonlContent], { type: 'application/x-jsonlines;charset=utf-8;' });
    const link = document.createElement("a");
    const dateStr = new Date().toISOString().split('T')[0];

    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `deribit_block_rfqs_${selectedAsset}_${dateStr}.jsonl`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 3. CHART INTERACTION ENGINE
function renderChart() {
    const filterValue = document.getElementById('expiryFilter').value;
    const sortedUniqueStrikes = [...new Set(globalDataset.map(d => d.strike))].sort((a,b) => a-b);
    const categories = ["Call Buy Blocked", "Call Sell Blocked", "Put Buy Blocked", "Put Sell Blocked"];
    const colors = {
        "Call Buy Blocked": "#55c79a", "Call Sell Blocked": "#f28b70",
        "Put Buy Blocked": "#e7c56d", "Put Sell Blocked": "#6bbac4"
    };

    const globalTotals = new Map();
    const scopedTotals = new Map();
    const scopedRecords = new Map();
    let maxGlobalVolume = 0;
    globalDataset.forEach(record => {
        const key = `${record.strike}|${record.category}`;
        const volume = Number(record.volume) || 0;
        const globalTotal = (globalTotals.get(key) || 0) + volume;
        globalTotals.set(key, globalTotal);
        if (globalTotal > maxGlobalVolume) maxGlobalVolume = globalTotal;

        if (filterValue === 'All' || record.expiry === filterValue) {
            scopedTotals.set(key, (scopedTotals.get(key) || 0) + volume);
            if (!scopedRecords.has(key)) scopedRecords.set(key, []);
            scopedRecords.get(key).push(record);
        }
    });
    const xAxisLimit = maxGlobalVolume * 1.05 || 10; // 5% padding cushion

    const datasets = categories.map(cat => {
        const isCall = cat.startsWith("Call");

        const dataPoints = sortedUniqueStrikes.map(strike => {
            const sum = scopedTotals.get(`${strike}|${cat}`) || 0;
            return isCall ? -sum : sum;
        });

        return {
            label: cat,
            data: dataPoints,
            backgroundColor: colors[cat],
            borderColor: colors[cat],
            borderWidth: 1,
            barThickness: 6,
            grouped: false
        };
    });

    if (chartInstance) { chartInstance.destroy(); }

    const ctx = document.getElementById('optionsChart').getContext('2d');
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedUniqueStrikes,
            datasets: datasets
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    // SURGICAL CHANGE: Explicitly clamp boundaries to the max profile size
                    min: -xAxisLimit,
                    max: xAxisLimit,
                    grid: { color: '#161b22' },
                    ticks: { color: '#8b949e', callback: val => formatNumber(Math.abs(val), 0) }
                },
                y: {
                    reverse: true,
                    grid: { color: '#161b22' },
                    ticks: { color: '#8b949e', font: { size: 11 }, callback: val => formatNumber(val, 0) }
                }
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: '#c9d1d9', font: { size: 12 } } },
                tooltip: {
                    mode: 'y',
                    intersect: false,
                    backgroundColor: '#161a22',
                    titleColor: '#ffffff',
                    bodyColor: '#ffffff',
                    borderColor: '#30363d',
                    borderWidth: 1,
                    padding: 14,
                    bodyFont: { size: 13 },
                    titleFont: { size: 14, weight: 'bold' },
                    callbacks: {
                        label: function(context) {
                            const strike = parseInt(context.label);
                            const cat = context.dataset.label;

                            const matches = scopedRecords.get(`${strike}|${cat}`) || [];
                            if (matches.length === 0) return null;

                            const categoryTotal = matches.reduce((acc, curr) => acc + curr.volume, 0);
                            const outputLines = [` • ${cat}: Total ${formatNumber(categoryTotal, 1)} consist of:`];

                            const breakdownMap = {};
                            matches.forEach(m => {
                                breakdownMap[m.expiry] = (breakdownMap[m.expiry] || 0) + m.volume;
                            });

                            const sortedExpiries = Object.keys(breakdownMap).sort((a, b) => {
                                return parseExpiryToDate(a) - parseExpiryToDate(b);
                            });

                            sortedExpiries.forEach(expiry => {
                                const vol = breakdownMap[expiry];
                                outputLines.push(`   ↳ ${formatNumber(vol, 1)} (${expiry})`);
                            });

                            return outputLines;
                        },
                        footer: function(tooltipItems) {
                            let strikeTotal = 0;
                            tooltipItems.forEach(item => {
                                if (Array.isArray(item.raw)) return;
                                strikeTotal += Math.abs(item.raw);
                            });
                            return `\nTotal Combined Strike Volume: ${formatNumber(strikeTotal, 1)}`;
                        }
                    }
                }
            }
        }
    });
}

function stopAndDisconnectDashboard() {
    document.getElementById('liveStatusBadge').classList.add('hidden');
    document.getElementById('filePicker').value = "";
    document.getElementById('apiProgressContainer').classList.add('hidden');
    document.getElementById('dashboardScreen').classList.add('hidden', 'opacity-0');
    document.getElementById('uploadScreen').classList.remove('hidden');
}

// -------------------------
// Strategy (RFQ) table + pricing
// -------------------------
let parsedStrategies = [];
// sorting state for strategies table
const strategiesSort = { by: 'id', dir: 1 };
// simple in-memory price cache to avoid rate limits
const priceCache = { store: {}, ttl: 60 * 1000, inflight: {} }; // 60s TTL, inflight dedupe
let priceFetchQueue = Promise.resolve();

// hydrate price cache from localStorage so repeated lookups survive reloads
try {
    const raw = localStorage.getItem('priceCacheStore');
    if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') priceCache.store = parsed;
    }
} catch (e) { console.warn('priceCache load failed', e); }

function processAndRenderPositions() {
    parsedStrategies = [];

    rawFetchedRfqs.forEach((rfq, idx) => {
        const amount = rfq.amount || 0;
        const rawLegs = (rfq.legs || []).map(l => ({ ratio: Number(l.ratio || 1), raw: l })).filter(Boolean);
        const sumRatio = rawLegs.reduce((s, r) => s + (isFinite(r.ratio) ? r.ratio : 1), 0) || 1;
        const legs = rawLegs.map(({ ratio, raw }) => {
            const leg = raw;
            const inst = leg.instrument_name || "";
            const m = inst.match(/^(BTC|ETH)-([0-9A-Z]+)-(\d+)-([CP])$/);
            if (!m) return null;

            const strike = parseInt(m[3]);
            const expiry = m[2];
            const type = m[4] === 'C' ? 'Call' : 'Put';
            const side = (leg.direction || 'buy').toLowerCase();
            // correct leg sizing: amount divided by sum of ratios, times leg ratio
            const size = Number(amount) / sumRatio * ratio;
            const entryPrice = Number(leg.price || rfq.price || rfq.avg_price || rfq.average_price || leg.premium || 0) || 0;
            const indexPrice = Number(rfq.index_prices?.btc_usd) || null;

            return {
                instrument: inst,
                strike,
                expiry,
                type,
                side,
                ratio,
                size,
                entryPrice,
                entryIndexPrice: indexPrice,
                entryPriceUsd: indexPrice != null ? entryPrice * indexPrice : null,
                currentPrice: null,
                currentIndexPrice: null,
                pnl: null
            };
        }).filter(Boolean);

        const id = rfq.id || rfq.request_id || `rfq_${idx}`;
        parsedStrategies.push({
            id,
            rfqIndex: idx,
            timestamp: rfq.timestamp || rfq.created || null,
            amount: Number(rfq.amount || 0),
            isFetchingPrices: false,
            legs
        });
    });

    // attach btcPriceAtEntry (initialize null) for each strategy so UI can display placeholder
    parsedStrategies.forEach(s => {
        const entryLeg = s.legs.find(l => l.entryPriceUsd != null);
        s.btcPriceAtEntry = entryLeg?.entryIndexPrice ?? null;
    });

    strategiesSort.by = 'netSize';
    strategiesSort.dir = -1;
    renderStrategiesTable();
    startAutomaticPriceFetch();
}

function resetAutomaticPriceFetch() {
    autoFetchGeneration++;
    autoFetchLargeStrategiesStarted = false;
}

function getLargeStrategyPriceQueue() {
    return parsedStrategies
        .map(strategy => ({
            strategy,
            contracts: strategy.legs.reduce((total, leg) => total + Math.abs(Number(leg.size) || 0), 0)
        }))
        .filter(item => item.contracts >= AUTO_FETCH_MIN_CONTRACTS)
        .sort((a, b) => b.contracts - a.contracts)
        .map(item => item.strategy);
}

function updateStrategyFetchButton(strategy) {
    const button = [...document.querySelectorAll('.col-rfq button[data-rfq-id]')]
        .find(item => item.dataset.rfqId === String(strategy.id));
    if (!button) return;

    const labels = {
        idle: 'Fetch prices',
        queued: 'Queued',
        fetching: 'Fetching...',
        done: 'Refresh prices',
        partial: 'Retry missing',
        failed: 'Retry prices'
    };
    button.textContent = labels[strategy.priceFetchState || 'idle'];
    button.disabled = strategy.isFetchingPrices || strategy.priceFetchState === 'queued' || strategy.priceFetchState === 'fetching';
}

function startAutomaticPriceFetch() {
    if (autoFetchLargeStrategiesStarted) return;
    autoFetchLargeStrategiesStarted = true;
    const generation = autoFetchGeneration;
    const queue = getLargeStrategyPriceQueue();
    const status = document.getElementById('priceFetchStatus');

    if (queue.length === 0) {
        status.textContent = `No RFQs with ${AUTO_FETCH_MIN_CONTRACTS}+ contracts to fetch.`;
        return;
    }

    requestAnimationFrame(async () => {
        queue.forEach(strategy => {
            strategy.priceFetchState = 'queued';
            updateStrategyFetchButton(strategy);
        });

        let completed = 0;
        let partial = 0;
        let failed = 0;
        for (let index = 0; index < queue.length; index++) {
            if (generation !== autoFetchGeneration) return;
            const strategy = queue[index];
            const contracts = strategy.legs.reduce((total, leg) => total + Math.abs(Number(leg.size) || 0), 0);
            strategy.priceFetchState = 'fetching';
            status.textContent = `Fetching ${index + 1} of ${queue.length}: ${formatNumber(contracts, 2)} contracts.`;
            updateStrategyFetchButton(strategy);

            const succeeded = await fetchStrategyPrices(strategy.id, false);
            if (generation !== autoFetchGeneration) return;
            if (succeeded && strategy.priceFetchState === 'partial') partial++;
            completed++;
            if (!succeeded) failed++;
            updateStrategyFetchButton(strategy);

        }

        status.textContent = `Auto-fetch complete: ${completed - partial - failed} succeeded, ${partial} partial, ${failed} failed.`;
        renderStrategiesTable();
    });
}

function setStrategiesSort(by) {
    if (strategiesSort.by === by) {
        strategiesSort.dir = -strategiesSort.dir;
    } else {
        strategiesSort.by = by;
        strategiesSort.dir = 1;
    }
    renderStrategiesTable();
}

function renderChartAndTable() {
    renderChart();
    renderStrategiesTable();
}

// Date range modal handlers and sort shortcuts
function openDateRangeModal() {
    const modal = document.getElementById('dateRangeModal');
    if (!modal) return;
    // populate inputs with current state
    try { document.getElementById('dateFrom').value = dateFilterFrom || ''; } catch(e){}
    try { document.getElementById('dateTo').value = dateFilterTo || ''; } catch(e){}
    modal.classList.remove('hidden');
}

function closeDateRangeModal() {
    const modal = document.getElementById('dateRangeModal'); if (!modal) return; modal.classList.add('hidden');
}

function applyDateRangeFilter() {
    const from = document.getElementById('dateFrom')?.value || null;
    const to = document.getElementById('dateTo')?.value || null;
    dateFilterFrom = from || null;
    dateFilterTo = to || null;
    closeDateRangeModal();
    renderChartAndTable();
}

function clearDateRangeFilter() {
    dateFilterFrom = null; dateFilterTo = null;
    try { document.getElementById('dateFrom').value = ''; } catch(e){}
    try { document.getElementById('dateTo').value = ''; } catch(e){}
    closeDateRangeModal();
    renderChartAndTable();
}

function setDateRangeToday() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const s = `${yyyy}-${mm}-${dd}`;
    try { document.getElementById('dateFrom').value = s; } catch(e){}
    try { document.getElementById('dateTo').value = s; } catch(e){}
    dateFilterFrom = s; dateFilterTo = s;
    closeDateRangeModal();
    renderChartAndTable();
}

function setDateRangeYesterday() {
    const today = new Date();
    today.setUTCDate(today.getUTCDate() - 1);
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth()+1).padStart(2,'0');
    const dd = String(today.getUTCDate()).padStart(2,'0');
    const s = `${yyyy}-${mm}-${dd}`;
    try { document.getElementById('dateFrom').value = s; } catch(e){}
    try { document.getElementById('dateTo').value = s; } catch(e){}
    dateFilterFrom = s; dateFilterTo = s;
    closeDateRangeModal();
    renderChartAndTable();
}

function setSortShortcut(kind) {
    if (kind === 'date') { strategiesSort.by = 'timestampMsec'; strategiesSort.dir = -1; }
    else if (kind === 'contracts') { strategiesSort.by = 'netSize'; strategiesSort.dir = -1; }
    else if (kind === 'rr') { strategiesSort.by = 'rr'; strategiesSort.dir = -1; }
    renderStrategiesTable();
}

async function fetchStrategyPrices(strategyId, renderOnUpdate = true) {
    const strategy = parsedStrategies.find(item => item.id === strategyId);
    if (!strategy || strategy.isFetchingPrices) return false;

    strategy.isFetchingPrices = true;
    strategy.priceFetchState = 'fetching';
    if (renderOnUpdate) renderStrategiesTable();

    let updatedLegCount = 0;

    try {
        const instruments = [...new Set(strategy.legs.map(leg => leg.instrument))];
        const priceMap = await fetchCurrentPricesForInstruments(instruments);

        strategy.legs.forEach(leg => {
            const quote = priceMap[leg.instrument];
            if (quote?.price == null) return;

            leg.currentPrice = quote.price;
            if (quote.indexPrice != null) leg.currentIndexPrice = quote.indexPrice;
            const legPnl = (leg.currentPrice - leg.entryPrice) * leg.size * (leg.side === 'buy' ? 1 : -1);
            leg.pnl = legPnl;
            leg.pnlUsd = leg.currentIndexPrice != null ? legPnl * leg.currentIndexPrice : null;
            updatedLegCount++;
        });

        const pricedLegs = strategy.legs.filter(leg => leg.currentPrice != null);
        strategy.pnl = pricedLegs.length ? pricedLegs.reduce((sum, leg) => sum + (leg.pnl || 0), 0) : null;
        const usdPricedLegs = pricedLegs.filter(leg => leg.pnlUsd != null);
        strategy.pnlUsd = usdPricedLegs.length ? usdPricedLegs.reduce((sum, leg) => sum + leg.pnlUsd, 0) : null;
        strategy.priceFetchState = pricedLegs.length === 0
            ? 'failed'
            : (updatedLegCount < strategy.legs.length ? 'partial' : 'done');
    } catch (error) {
        console.error('Price fetch error', error);
        strategy.priceFetchState = strategy.legs.some(leg => leg.currentPrice != null) ? 'partial' : 'failed';
    } finally {
        strategy.isFetchingPrices = false;
        if (renderOnUpdate) renderStrategiesTable();
        else updateStrategyFetchButton(strategy);
    }
    return strategy.legs.some(leg => leg.currentPrice != null);
}

function calculateStrategyRiskReward(strategy) {
    const strikes = strategy.legs.map(leg => Number(leg.strike)).filter(Number.isFinite);
    if (strikes.length === 0) return null;

    const start = Math.max(0, Math.min(...strikes) - 10000);
    const end = Math.max(...strikes) + 10000;
    const step = Math.max(1, Math.round((end - start) / 50));
    let maxProfit = 0;
    let maxLoss = 0;

    for (let underlying = start; underlying <= end; underlying += step) {
        let payoff = 0;
        strategy.legs.forEach(leg => {
            const premium = Number(leg.entryPriceUsd != null ? leg.entryPriceUsd : leg.entryPrice) || 0;
            const ratio = Number(leg.ratio) || 0;
            const intrinsic = leg.type === 'Call'
                ? Math.max(0, underlying - leg.strike)
                : Math.max(0, leg.strike - underlying);
            payoff += (leg.side === 'buy' ? 1 : -1) * (intrinsic - premium) * ratio;
        });
        maxProfit = Math.max(maxProfit, payoff);
        maxLoss = Math.min(maxLoss, payoff);
    }

    if (maxLoss === 0) return maxProfit > 0 ? Infinity : null;
    return maxProfit / Math.abs(maxLoss);
}

async function fetchCurrentPricesForInstruments(instruments) {
    const now = Date.now();
    const uniqueInstruments = [...new Set(instruments)];
    const settledResults = await Promise.allSettled(uniqueInstruments.map(async inst => {
        const cached = priceCache.store[inst];
        if (cached && (now - cached.ts) < priceCache.ttl) {
            return [inst, { price: cached.price, indexPrice: cached.indexPrice ?? null }];
        }

        let request = priceCache.inflight[inst];
        if (!request) {
            request = priceFetchQueue.then(async () => {
            try {
                const url = `https://www.deribit.com/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst)}`;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) return null;
                const payload = await res.json();
                const r = payload.result || {};
                let price = r.last_price ?? r.last ?? r.last_trade_price ?? null;
                if (!price) {
                    const bid = r.best_bid_price || null;
                    const ask = r.best_ask_price || null;
                    if (bid != null && ask != null) price = (bid + ask) / 2;
                }
                if (price != null) {
                    const numP = Number(price);
                    const indexPrice = Number(r.index_price) || null;
                    const quote = { price: numP, indexPrice, ts: Date.now() };
                    priceCache.store[inst] = quote;
                    return { price: numP, indexPrice };
                }
            } catch (e) {
                console.warn('fetch price failed for', inst, e);
            } finally {
                delete priceCache.inflight[inst];
            }
            return null;
            });
            priceCache.inflight[inst] = request;
            priceFetchQueue = request
                .catch(() => null)
                .then(() => new Promise(resolve => setTimeout(resolve, PRICE_REQUEST_DELAY_MS)));
        }

        const quote = await request;
        return quote ? [inst, quote] : null;
    }));

    try { localStorage.setItem('priceCacheStore', JSON.stringify(priceCache.store)); } catch (e) {}
    const results = settledResults
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);
    return Object.fromEntries(results);
}

function getStrategiesForCurrentView() {
    const expiryFilter = document.getElementById('expiryFilter').value;
    let strategies = parsedStrategies.slice();
    if (expiryFilter && expiryFilter !== 'All') {
        strategies = strategies.filter(strategy => strategy.legs.some(leg => leg.expiry === expiryFilter));
    }

    if (dateFilterFrom || dateFilterTo) {
        const startMs = dateFilterFrom ? new Date(`${dateFilterFrom}T00:00:00`).getTime() : null;
        const endMs = dateFilterTo ? new Date(`${dateFilterTo}T23:59:59.999`).getTime() : null;
        strategies = strategies.filter(strategy => {
            const timestamp = strategy.timestamp || 0;
            return (startMs == null || timestamp >= startMs) && (endMs == null || timestamp <= endMs);
        });
    }

    strategies = strategies.map(strategy => {
        const netEntry = strategy.legs.reduce((sum, leg) => sum + leg.entryPrice * leg.size * (leg.side === 'buy' ? -1 : 1), 0);
        const netEntryUsd = strategy.legs.reduce((sum, leg) => sum + (leg.entryPriceUsd || 0) * leg.size * (leg.side === 'buy' ? -1 : 1), 0);
        const netCurrent = strategy.legs.reduce((sum, leg) => sum + ((leg.currentPrice || 0) * leg.size * (leg.side === 'buy' ? 1 : -1)), 0);
        const pnl = strategy.legs.reduce((sum, leg) => sum + (leg.pnl || 0), 0);
        const pnlUsd = strategy.legs.reduce((sum, leg) => sum + (leg.pnlUsd || 0), 0);
        const netSize = strategy.legs.reduce((sum, leg) => sum + Math.abs(leg.size || 0), 0);
        const firstExpiryRaw = strategy.legs[0]?.expiry || '';
        return Object.assign({}, strategy, {
            netEntry,
            netEntryUsd,
            netCurrent,
            pnl,
            pnlUsd,
            netSize,
            legCount: strategy.legs.length,
            rr: calculateStrategyRiskReward(strategy),
            firstExpiry: firstExpiryRaw ? parseExpiryToDate(firstExpiryRaw).getTime() : 0,
            firstExpiryLabel: firstExpiryRaw,
            timestampMsec: strategy.timestamp || 0
        });
    });

    const { by, dir } = strategiesSort;
    strategies.sort((a, b) => {
        const valueA = a[by] == null ? -Infinity : a[by];
        const valueB = b[by] == null ? -Infinity : b[by];
        if (typeof valueA === 'string') return valueA.localeCompare(valueB) * dir;
        return (valueA - valueB) * dir;
    });

    return strategies;
}

function renderStrategiesTable() {
    const container = document.getElementById('positionsTable');
    payoffChartInstances.forEach(chart => chart.destroy());
    payoffChartInstances.clear();
    container.innerHTML = '';

    if (parsedStrategies.length === 0) {
        container.innerHTML = '<div class="text-xs text-gray-500">No parsed positions available.</div>';
        return;
    }

    // header row for card layout (sticky)
    const header = document.createElement('div');
    header.className = 'cards-header text-xs text-gray-400';
    header.innerHTML = `
        <div>RFQ</div>
        <div>Entry Date</div>
        <div>Legs</div>
        <div style="text-align:center">Total Contracts</div>
        <div style="text-align:center">Net Entry (BTC)</div>
        <div style="text-align:center">Net Entry (USD)</div>
        <div style="text-align:center">Net Current</div>
        <div style="text-align:center">P&L</div>
        <div style="text-align:center">P&L (USD)</div>
        <div style="text-align:center">RR</div>
    `;
    // attach sorting handlers to header labels where appropriate
    header.querySelector('div:nth-child(1)').onclick = () => setStrategiesSort('id');
    header.querySelector('div:nth-child(2)').onclick = () => setStrategiesSort('timestampMsec');
    header.querySelector('div:nth-child(3)').onclick = () => setStrategiesSort('legCount');
    header.querySelector('div:nth-child(4)').onclick = () => setStrategiesSort('netSize');
    header.querySelector('div:nth-child(5)').onclick = () => setStrategiesSort('netEntry');
    header.querySelector('div:nth-child(6)').onclick = () => setStrategiesSort('netEntryUsd');
    header.querySelector('div:nth-child(7)').onclick = () => setStrategiesSort('netCurrent');
    header.querySelector('div:nth-child(8)').onclick = () => setStrategiesSort('pnl');
    header.querySelector('div:nth-child(9)').onclick = () => setStrategiesSort('pnlUsd');
    header.querySelector('div:nth-child(10)').onclick = () => setStrategiesSort('rr');

    container.appendChild(header);

    const toRender = getStrategiesForCurrentView();

    // summary row: totals (computed from filtered/sorted view)
    const totalSummary = document.createElement('div'); totalSummary.className = 'text-sm text-gray-300 mb-2';
    const totalContractsSum = toRender.reduce((s, r) => s + (Number(r.netSize) || 0), 0);
    const totalPnlSum = toRender.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
    const totalPnlUsdSum = toRender.reduce((s, r) => s + (Number(r.pnlUsd) || 0), 0);
    totalSummary.innerHTML = `<strong>Total Contracts:</strong> ${formatNumber(totalContractsSum, 2)} &nbsp; <strong>Total P&L:</strong> ${formatNumber(totalPnlSum, 4)} &nbsp; <strong>Total P&L (USD):</strong> ${formatNumber(totalPnlUsdSum, 4)}`;
    container.insertBefore(totalSummary, header);

    // render each strategy as a card with a legs sub-table and a full-width payoff chart below
    toRender.forEach(strategy => {
        const card = document.createElement('div'); card.className = 'strategy-card';

        const top = document.createElement('div'); top.className = 'card-top text-sm text-gray-300';

        const colRFQ = document.createElement('div'); colRFQ.className = 'col-rfq';
        const rfqId = document.createElement('div'); rfqId.innerText = strategy.id;
        const fetchButton = document.createElement('button');
        fetchButton.className = 'mt-2 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed';
        fetchButton.dataset.rfqId = String(strategy.id);
        const priceFetchLabels = { idle: 'Fetch prices', queued: 'Queued', fetching: 'Fetching...', done: 'Refresh prices', partial: 'Retry missing', failed: 'Retry prices' };
        fetchButton.innerText = priceFetchLabels[strategy.priceFetchState || 'idle'];
        fetchButton.disabled = strategy.isFetchingPrices || strategy.priceFetchState === 'queued' || strategy.priceFetchState === 'fetching';
        fetchButton.onclick = () => fetchStrategyPrices(strategy.id);
        colRFQ.appendChild(rfqId);
        colRFQ.appendChild(fetchButton);
        const colDate = document.createElement('div'); colDate.className = 'col-date';
        if (strategy.timestamp) {
            const dt = new Date(strategy.timestamp + (7*60*60*1000)).toISOString().replace('T',' ').split('.')[0];
            const btcLine = strategy.btcPriceAtEntry != null ? `btc@${formatNumber(strategy.btcPriceAtEntry, 2)}` : 'btc@-';
            colDate.innerHTML = `${dt}<br/><span class="text-xs text-gray-500">${btcLine}</span>`;
        } else {
            colDate.innerText = '-';
        }
        // Amount column removed (duplicate of Total Contracts)

        const colLegs = document.createElement('div'); colLegs.className = 'col-legs';
        const legsTable = document.createElement('table'); legsTable.className = 'card-legs-table';
        const ltHead = document.createElement('thead'); ltHead.innerHTML = '<tr><th>Side</th><th>Type</th><th>Expiry</th><th>Strike</th><th>LegAmt</th><th>Entry</th><th>Entry (USD)</th><th>Entry Total (BTC)</th><th>Entry Total (USD)</th><th>Current (BTC)</th><th>Current (USD)</th><th>PnL</th><th>P&L (USD)</th></tr>';
        const ltBody = document.createElement('tbody');
        strategy.legs.forEach(l => {
            const tr = document.createElement('tr');
            const tdSide = document.createElement('td'); tdSide.innerText = l.side.toUpperCase();
            const tdType = document.createElement('td'); tdType.innerText = l.type;
            const tdExpiry = document.createElement('td'); tdExpiry.innerText = l.expiry || '-';
            const tdStrike = document.createElement('td'); tdStrike.innerText = formatNumber(l.strike, 0);
            const tdAmt = document.createElement('td'); tdAmt.innerText = formatNumber(l.size, 2);
            const tdEntry = document.createElement('td'); tdEntry.innerText = l.entryPrice != null ? formatNumber(l.entryPrice, 4) : '-';
            const tdEntryUsd = document.createElement('td'); tdEntryUsd.innerText = l.entryPriceUsd != null ? formatNumber(l.entryPriceUsd, 4) : '-';
            const tdEntryTotalBtc = document.createElement('td'); tdEntryTotalBtc.innerText = formatNumber(l.entryPrice * l.size, 4);
            const tdEntryTotalUsd = document.createElement('td'); tdEntryTotalUsd.innerText = l.entryPriceUsd != null ? formatNumber(l.entryPriceUsd * l.size, 2) : '-';
            const tdCurrent = document.createElement('td'); tdCurrent.innerText = l.currentPrice != null ? formatNumber(l.currentPrice, 4) : '-';
            const tdCurrentUsd = document.createElement('td'); tdCurrentUsd.innerText = l.currentPrice != null && l.currentIndexPrice != null ? formatNumber(l.currentPrice * l.currentIndexPrice, 2) : '-';
            const tdPnl = document.createElement('td'); tdPnl.innerText = l.pnl != null ? formatNumber(l.pnl, 4) : '-';
            const tdPnlUsd = document.createElement('td'); tdPnlUsd.innerText = l.pnlUsd != null ? formatNumber(l.pnlUsd, 4) : '-';
            if (l.pnl != null) tdPnl.className = l.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                if (l.pnlUsd != null) tdPnlUsd.className = l.pnlUsd >= 0 ? 'pnl-positive' : 'pnl-negative';
                tr.appendChild(tdSide); tr.appendChild(tdType); tr.appendChild(tdExpiry); tr.appendChild(tdStrike); tr.appendChild(tdAmt); tr.appendChild(tdEntry); tr.appendChild(tdEntryUsd); tr.appendChild(tdEntryTotalBtc); tr.appendChild(tdEntryTotalUsd); tr.appendChild(tdCurrent); tr.appendChild(tdCurrentUsd); tr.appendChild(tdPnl); tr.appendChild(tdPnlUsd);
            ltBody.appendChild(tr);
        });
        legsTable.appendChild(ltHead); legsTable.appendChild(ltBody);
        colLegs.appendChild(legsTable);

        const colNetSize = document.createElement('div'); colNetSize.className = 'col-netsize'; colNetSize.style.textAlign = 'center'; colNetSize.innerText = formatNumber(strategy.netSize || 0, 2);
        const colNetEntry = document.createElement('div'); colNetEntry.className = 'col-netentry'; colNetEntry.innerText = (strategy.netEntry != null) ? formatNumber(strategy.netEntry, 4) : '-';
        const colNetEntryUsd = document.createElement('div'); colNetEntryUsd.className = 'col-netentryusd'; colNetEntryUsd.innerText = (strategy.netEntryUsd != null) ? formatNumber(strategy.netEntryUsd, 4) : '-';
        const colNetCurrent = document.createElement('div'); colNetCurrent.className = 'col-netcurrent'; colNetCurrent.innerText = (strategy.netCurrent != null) ? formatNumber(strategy.netCurrent, 4) : '-';
        const colPnl = document.createElement('div'); colPnl.className = 'col-pnl'; colPnl.innerText = (strategy.pnl != null) ? formatNumber(strategy.pnl, 4) : '-'; if (strategy.pnl != null) colPnl.classList.add(strategy.pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
        const colPnlUsd = document.createElement('div'); colPnlUsd.className = 'col-pnlusd'; colPnlUsd.innerText = (strategy.pnlUsd != null) ? formatNumber(strategy.pnlUsd, 4) : '-'; if (strategy.pnlUsd != null) colPnlUsd.classList.add(strategy.pnlUsd >= 0 ? 'pnl-positive' : 'pnl-negative');
        const colRr = document.createElement('div'); colRr.className = 'col-rr'; colRr.style.textAlign = 'center'; colRr.innerText = strategy.rr === Infinity ? '∞' : (strategy.rr != null ? formatNumber(strategy.rr, 2) : '-');

        top.appendChild(colRFQ); top.appendChild(colDate); top.appendChild(colLegs); top.appendChild(colNetSize); top.appendChild(colNetEntry); top.appendChild(colNetEntryUsd); top.appendChild(colNetCurrent); top.appendChild(colPnl); top.appendChild(colPnlUsd); top.appendChild(colRr);

        const payoffRow = document.createElement('div'); payoffRow.className = 'payoff-row';
        const timeline = getStrategyPayoffTimeline(strategy);
        const selectedDays = Math.min(Number(strategy.payoffDays) || 0, timeline.maxDays);
        const controls = document.createElement('div'); controls.className = 'payoff-controls';
        const dayControl = document.createElement('input');
        dayControl.type = 'range'; dayControl.min = '0'; dayControl.max = String(timeline.maxDays);
        dayControl.step = '1'; dayControl.value = String(selectedDays);
        dayControl.setAttribute('aria-label', 'Payoff valuation day');
        const dateControl = document.createElement('input');
        dateControl.type = 'date'; dateControl.min = timeline.today; dateControl.max = timeline.expiryDate;
        dateControl.value = getPayoffDateForDay(selectedDays, timeline);
        dateControl.setAttribute('aria-label', 'Payoff valuation date');
        const dayLabel = document.createElement('span'); dayLabel.className = 'payoff-day-label';
        const ivLabel = document.createElement('label'); ivLabel.className = 'payoff-iv-label';
        const ivInput = document.createElement('input');
        ivInput.type = 'range'; ivInput.min = '10'; ivInput.max = '200'; ivInput.step = '1';
        ivInput.value = String(Math.min(200, Math.max(10, Number(strategy.payoffIv) || 60)));
        ivInput.setAttribute('aria-label', 'Implied volatility assumption');
        ivInput.title = 'Black–Scholes estimate with a 0% interest-rate assumption';
        const ivValue = document.createElement('output');
        ivLabel.append('Model IV ', ivInput, ivValue);
        controls.append(dayLabel, dayControl, dateControl, ivLabel);

        const updatePayoff = () => {
            strategy.payoffDays = Number(dayControl.value);
            strategy.payoffIv = Number(ivInput.value);
            dayLabel.textContent = `Day ${strategy.payoffDays} · ${getPayoffDateForDay(strategy.payoffDays, timeline)}`;
            ivValue.textContent = `${strategy.payoffIv}%`;
            dateControl.value = getPayoffDateForDay(strategy.payoffDays, timeline);
            updatePayoffMiniChart(strategy, canvas, timeline);
        };
        dayControl.addEventListener('input', updatePayoff);
        dateControl.addEventListener('change', () => {
            const selectedDate = Date.parse(`${dateControl.value}T00:00:00Z`);
            const todayDate = Date.parse(`${timeline.today}T00:00:00Z`);
            if (Number.isFinite(selectedDate)) {
                dayControl.value = String(Math.min(timeline.maxDays, Math.max(0, Math.round((selectedDate - todayDate) / 86400000))));
                updatePayoff();
            }
        });
        ivInput.addEventListener('input', updatePayoff);
        dayLabel.textContent = `Day ${selectedDays} · ${dateControl.value}`;
        ivValue.textContent = `${ivInput.value}%`;

        const chartContainer = document.createElement('div'); chartContainer.className = 'payoff-chart-container';
        const canvas = document.createElement('canvas'); canvas.id = `payoff_full_${strategy.id}`;
        canvas.style.width = '100%'; canvas.style.height = '100%';
        payoffRow.append(controls, chartContainer);
        chartContainer.appendChild(canvas);

        card.appendChild(top);
        card.appendChild(payoffRow);
        container.appendChild(card);

        requestAnimationFrame(() => {
            if (canvas.isConnected) renderPayoffMiniChart(strategy, canvas, timeline);
        });
    });
}

function getStrategyPayoffTimeline(strategy) {
    const now = Date.now();
    const todayDate = new Date(now).toISOString().slice(0, 10);
    const expiryTimes = strategy.legs.map(leg => parseExpiryToDate(leg.expiry).getTime()).filter(Number.isFinite);
    const latestExpiry = expiryTimes.length ? Math.max(...expiryTimes) : now;
    const expiryDate = new Date(Math.max(now, latestExpiry)).toISOString().slice(0, 10);
    const todayMidnight = Date.parse(`${todayDate}T00:00:00Z`);
    const expiryMidnight = Date.parse(`${expiryDate}T00:00:00Z`);
    return {
        today: todayDate,
        expiryDate,
        maxExpiry: latestExpiry,
        maxDays: Math.max(0, Math.round((expiryMidnight - todayMidnight) / 86400000))
    };
}

function getPayoffDateForDay(dayOffset, timeline) {
    const today = new Date(`${timeline.today}T00:00:00Z`);
    today.setUTCDate(today.getUTCDate() + Number(dayOffset));
    return today.toISOString().slice(0, 10) > timeline.expiryDate
        ? timeline.expiryDate
        : today.toISOString().slice(0, 10);
}

function getPayoffValuationTimestamp(dayOffset, timeline) {
    if (Number(dayOffset) === 0) return Date.now();
    const date = getPayoffDateForDay(dayOffset, timeline);
    return Math.min(timeline.maxExpiry, Date.parse(`${date}T08:00:00Z`));
}

function normalCdf(value) {
    const absolute = Math.abs(value);
    const t = 1 / (1 + 0.2316419 * absolute);
    const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
    const probability = 1 - density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return value >= 0 ? probability : 1 - probability;
}

function calculateOptionValue(underlying, strike, type, yearsRemaining, volatility) {
    const intrinsic = type === 'Call' ? Math.max(0, underlying - strike) : Math.max(0, strike - underlying);
    if (yearsRemaining <= 0 || volatility <= 0 || underlying <= 0 || strike <= 0) return intrinsic;

    const deviation = volatility * Math.sqrt(yearsRemaining);
    const d1 = (Math.log(underlying / strike) + 0.5 * volatility * volatility * yearsRemaining) / deviation;
    const d2 = d1 - deviation;
    return type === 'Call'
        ? underlying * normalCdf(d1) - strike * normalCdf(d2)
        : strike * normalCdf(-d2) - underlying * normalCdf(-d1);
}

function calculateStrategyPayoff(strategy, underlying, valuationTimestamp, impliedVolatility) {
    const volatility = impliedVolatility / 100;
    return strategy.legs.reduce((total, leg) => {
        const expiry = parseExpiryToDate(leg.expiry).getTime();
        const yearsRemaining = Math.max(0, (expiry - valuationTimestamp) / (365.25 * 86400000));
        const value = calculateOptionValue(underlying, Number(leg.strike), leg.type, yearsRemaining, volatility);
        const entryPremiumUsd = leg.entryPriceUsd != null
            ? Number(leg.entryPriceUsd)
            : Number(leg.entryPrice) * Number(leg.entryIndexPrice || strategy.btcPriceAtEntry || 1);
        const size = Number(leg.size ?? leg.ratio ?? 1);
        const direction = leg.side === 'buy' ? 1 : -1;
        return total + direction * (value - (Number.isFinite(entryPremiumUsd) ? entryPremiumUsd : 0)) * size;
    }, 0);
}

function getPayoffChartData(strategy, timeline, valuationTimestamp = null) {
    const strikes = strategy.legs.map(leg => Number(leg.strike)).filter(Number.isFinite);
    if (strikes.length === 0) return { labels: [], data: [] };
    const start = Math.max(0, Math.min(...strikes) - 10000);
    const end = Math.max(...strikes) + 10000;
    const step = Math.max(1, Math.round((end - start) / 50));
    const evaluatedAt = valuationTimestamp ?? getPayoffValuationTimestamp(strategy.payoffDays || 0, timeline);
    const impliedVolatility = Number(strategy.payoffIv) || 60;
    const labels = [];
    const data = [];

    for (let underlying = start; underlying <= end; underlying += step) {
        labels.push(underlying);
        data.push(calculateStrategyPayoff(strategy, underlying, evaluatedAt, impliedVolatility));
    }
    return { labels, data };
}

function updatePayoffMiniChart(strategy, canvas, timeline) {
    const chart = canvas.payoffChart;
    if (!chart) return;
    const { labels, data } = getPayoffChartData(strategy, timeline);
    const expiryData = getPayoffChartData(strategy, timeline, timeline.maxExpiry).data;
    chart.data.labels = labels;
    chart.data.datasets[0].data = labels.map(() => 0);
    chart.data.datasets[1].data = expiryData;
    chart.data.datasets[2].data = data;
    chart.update('none');
}

function renderPayoffMiniChart(strategy, canvas, timeline) {
    try {
        const { labels, data } = getPayoffChartData(strategy, timeline);
        const expiryData = getPayoffChartData(strategy, timeline, timeline.maxExpiry).data;

        // eslint-disable-next-line no-unused-vars
        // add a zero-profit baseline dataset so charts show the zero line
        const zeroData = labels.map(() => 0);
        const mini = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [
                { label: 'Zero P&L', data: zeroData, borderColor: '#9ca3af', borderWidth: 1, pointRadius: 0, borderDash: [4,4], fill: false, tension: 0, order: 0 },
                { label: 'Expiry', data: expiryData, borderColor: 'rgba(185, 196, 203, 0.7)', borderWidth: 1.5, pointRadius: 0, borderDash: [6,4], fill: false, tension: 0, order: 2 },
                { label: 'Selected date', data, borderColor: '#78d5ad', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: 'rgba(120,213,173,0.08)', order: 1 }
            ] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: {
                            color: '#9ca3af',
                            boxWidth: 18,
                            padding: 8,
                            filter: item => item.text !== 'Zero P&L'
                        }
                    },
                    tooltip: {
                        enabled: true,
                        mode: 'index',
                        intersect: false,
                        filter: item => item.datasetIndex !== 0,
                        callbacks: {
                            title: (items) => {
                                // Chart.js provides label in items[0].label as underlying price
                                return `X: Price ${formatNumber(items[0]?.label, 2)}`;
                            },
                            label: (context) => {
                                const y = context.parsed && context.parsed.y != null ? context.parsed.y : context.raw;
                                return `${context.dataset.label}: P&L ${formatNumber(y, 2)}`;
                            }
                        }
                    }
                },
                scales: {
                        x: { display: true, title: { display: true, text: 'Underlying Price (USD)', color: '#9ca3af' }, ticks: { callback: val => formatNumber(val, 0) } },
                    y: { display: true, title: { display: true, text: 'Modeled P&L (USD)', color: '#9ca3af' }, ticks: { callback: val => formatNumber(val, 2) } }
                }
            }
        });
        canvas.payoffChart = mini;
        payoffChartInstances.add(mini);
    } catch (e) {
        console.warn('mini chart failed', e);
    }
}

// Export currently displayed strategies (respecting expiry filter and sort) to CSV
function exportStrategiesCSV() {
    if (!parsedStrategies || parsedStrategies.length === 0) {
        alert('No strategies to export.');
        return;
    }

    const toRender = getStrategiesForCurrentView();

    // build CSV rows
    const rows = toRender.map(s => {
        const legsText = s.legs.map(l => {
            const currentUsd = l.currentPrice != null && l.currentIndexPrice != null ? l.currentPrice * l.currentIndexPrice : '';
            return [l.instrument, l.strike, l.type, l.side, l.ratio, Number(l.size).toFixed(2), l.entryPrice,
                l.entryPriceUsd ?? '', l.entryPrice * l.size, l.entryPriceUsd != null ? l.entryPriceUsd * l.size : '',
                l.currentPrice ?? '', currentUsd, l.pnl ?? '', l.pnlUsd ?? ''].join('|');
        }).join(' ; ');
        const dateUtc7 = s.timestamp ? new Date(s.timestamp + (7*60*60*1000)).toISOString().replace('T', ' ').split('.')[0] : '';
        return {
            RFQ: s.id,
            Date: dateUtc7,
            Timestamp: s.timestamp || '',
            Expiry: s.firstExpiryLabel || '',
            NetSize: Number(s.netSize || 0).toFixed(2),
            NetEntry: (s.netEntry != null) ? s.netEntry.toFixed(4) : '',
            NetEntryUsd: (s.netEntryUsd != null) ? s.netEntryUsd.toFixed(4) : '',
            NetCurrent: (s.netCurrent != null) ? s.netCurrent.toFixed(4) : '',
            PnL: (s.pnl != null) ? s.pnl.toFixed(4) : '',
            PnLUsd: (s.pnlUsd != null) ? s.pnlUsd.toFixed(4) : '',
            LegCount: s.legs.length,
            Legs: legsText
        };
    });

    // CSV header
    const header = ['RFQ','Date','Timestamp','Expiry','NetSize','NetEntry','NetEntryUsd','NetCurrent','PnL','PnLUsd','LegCount','Legs'];
    const escapeCsv = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };

    const csvLines = [header.join(',')].concat(rows.map(r => header.map(h => escapeCsv(r[h])).join(',')));
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `deribit_block_rfqs_${selectedAsset}_${dateStr}.csv`;
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

