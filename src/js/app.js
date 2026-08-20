let globalDataset = [];
let rawFetchedRfqs = [];
let chartInstance = null;
let selectedAsset = 'BTC';
let isFetchingApi = false;

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
}

function appendApiLog(msg) {
    const logger = document.getElementById('apiLogOutput');
    const stamp = new Date().toTimeString().split(' ')[0];
    logger.innerText += `[${stamp}] ${msg}\n`;
    logger.scrollTop = logger.scrollHeight;
}

// PIPELINE A: LOCAL DATA UPLOAD FILE
function handleFileLoading(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        selectedAsset = 'BTC';
        document.getElementById('dashTitleAsset').innerText = selectedAsset;
        globalDataset = parseRawJsonLines(e.target.result);
        updateExpiryFilterDropdown();
        swapScreenToDashboard();
        renderChart();
        processAndRenderPositions();
    };
    reader.readAsText(file);
}

// PIPELINE B: SEQUENTIAL PAGINATION PARSER ENGINE FOR GET_BLOCK_RFQ_TRADES
async function startLiveApiEngine() {
    if (isFetchingApi) return;
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
            countTxt.innerText = `${parsedRecordsAccumulator.length} active leg records`;

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
    const scopeData = filterValue === 'All'
        ? globalDataset
        : globalDataset.filter(d => d.expiry === filterValue);

    const sortedUniqueStrikes = [...new Set(globalDataset.map(d => d.strike))].sort((a,b) => a-b);
    const categories = ["Call Buy Blocked", "Call Sell Blocked", "Put Buy Blocked", "Put Sell Blocked"];
    const colors = {
        "Call Buy Blocked": "#2ca02c", "Call Sell Blocked": "#9467bd",
        "Put Buy Blocked": "#bcbd22", "Put Sell Blocked": "#1f77b4"
    };

    // SURGICAL CHANGE: Calculate absolute maximum volume across all expiries to lock the X-axis limits
    let maxGlobalVolume = 0;
    sortedUniqueStrikes.forEach(strike => {
        categories.forEach(cat => {
            const matches = globalDataset.filter(d => d.strike === strike && d.category === cat);
            const sum = matches.reduce((acc, curr) => acc + curr.volume, 0);
            if (sum > maxGlobalVolume) maxGlobalVolume = sum;
        });
    });
    const xAxisLimit = maxGlobalVolume * 1.05 || 10; // 5% padding cushion

    const datasets = categories.map(cat => {
        const isCall = cat.startsWith("Call");

        const dataPoints = sortedUniqueStrikes.map(strike => {
            const matches = scopeData.filter(d => d.strike === strike && d.category === cat);
            const sum = matches.reduce((acc, curr) => acc + curr.volume, 0);
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
                    ticks: { color: '#8b949e', callback: val => Math.abs(val) }
                },
                y: {
                    reverse: true,
                    grid: { color: '#161b22' },
                    ticks: { color: '#8b949e', font: { size: 11 } }
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

                            const matches = scopeData.filter(d => d.strike === strike && d.category === cat);
                            if (matches.length === 0) return null;

                            const categoryTotal = matches.reduce((acc, curr) => acc + curr.volume, 0);
                            const outputLines = [` • ${cat}: Total ${categoryTotal.toFixed(1)} consist of:`];

                            const breakdownMap = {};
                            matches.forEach(m => {
                                breakdownMap[m.expiry] = (breakdownMap[m.expiry] || 0) + m.volume;
                            });

                            const sortedExpiries = Object.keys(breakdownMap).sort((a, b) => {
                                return parseExpiryToDate(a) - parseExpiryToDate(b);
                            });

                            sortedExpiries.forEach(expiry => {
                                const vol = breakdownMap[expiry];
                                outputLines.push(`   ↳ ${vol.toFixed(1)} (${expiry})`);
                            });

                            return outputLines;
                        },
                        footer: function(tooltipItems) {
                            let strikeTotal = 0;
                            tooltipItems.forEach(item => {
                                if (Array.isArray(item.raw)) return;
                                strikeTotal += Math.abs(item.raw);
                            });
                            return `\nTotal Combined Strike Volume: ${strikeTotal.toFixed(1)}`;
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

            return {
                instrument: inst,
                strike,
                expiry,
                type,
                side,
                ratio,
                size,
                entryPrice,
                currentPrice: null,
                pnl: null
            };
        }).filter(Boolean);

        const id = rfq.id || rfq.request_id || `rfq_${idx}`;
        parsedStrategies.push({
            id,
            rfqIndex: idx,
            timestamp: rfq.timestamp || rfq.created || null,
            amount: Number(rfq.amount || 0),
            legs
        });
    });

    // gather instruments and fetch current prices
    const instruments = [...new Set(parsedStrategies.flatMap(s => s.legs.map(l => l.instrument)))];
    fetchCurrentPricesForInstruments(instruments).then(priceMap => {
        parsedStrategies.forEach(strategy => {
            let strategyPnl = 0;
            let hasPrice = false;
            strategy.legs.forEach(leg => {
                    const cp = priceMap[leg.instrument];
                    leg.currentPrice = cp != null ? cp : null;
                    if (leg.currentPrice != null) hasPrice = true;
                    if (leg.currentPrice != null && leg.entryPrice != null) {
                        const diff = (leg.currentPrice - leg.entryPrice);
                        const legPnl = diff * leg.size * (leg.side === 'buy' ? 1 : -1);
                        leg.pnl = legPnl;
                        strategyPnl += legPnl;
                    } else {
                        leg.pnl = null;
                    }
                });
            strategy.pnl = hasPrice ? strategyPnl : null;
        });

        renderStrategiesTable();
    }).catch(err => {
        console.error('Price fetch error', err);
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

async function fetchCurrentPricesForInstruments(instruments) {
    const map = {};
    const now = Date.now();
    const fetchPromises = [];
    const inflightWaits = [];

    instruments.forEach(inst => {
        const cached = priceCache.store[inst];
        if (cached && (now - cached.ts) < priceCache.ttl) {
            map[inst] = cached.price;
            return;
        }

        // if there's already an inflight request for this instrument, wait for it
        if (priceCache.inflight[inst]) {
            inflightWaits.push(priceCache.inflight[inst].then(p => { if (p != null) map[inst] = p; }));
            return;
        }

        // otherwise, create a fetch promise and store it in inflight to dedupe concurrent calls
        const p = (async () => {
            try {
                const url = `https://www.deribit.com/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst)}`;
                const res = await fetch(url, { cache: 'no-store' });
                if (!res.ok) return null;
                const payload = await res.json();
                const r = payload.result || {};
                let price = r.last_price || r.last || r.last_trade_price || null;
                if (!price) {
                    const bid = r.best_bid_price || null;
                    const ask = r.best_ask_price || null;
                    if (bid != null && ask != null) price = (bid + ask) / 2;
                }
                if (price != null) {
                    const numP = Number(price);
                    priceCache.store[inst] = { price: numP, ts: Date.now() };
                    try { localStorage.setItem('priceCacheStore', JSON.stringify(priceCache.store)); } catch (e) { }
                    map[inst] = numP;
                    return numP;
                }
            } catch (e) {
                console.warn('fetch price failed for', inst, e);
            } finally {
                // clear inflight slot
                try { delete priceCache.inflight[inst]; } catch (e) {}
            }
            return null;
        })();

        priceCache.inflight[inst] = p;
        fetchPromises.push(p);
    });

    // wait for all inflight and fetch promises to resolve
    await Promise.all([...inflightWaits, ...fetchPromises]);

    return map;
}

function renderStrategiesTable() {
    const container = document.getElementById('positionsTable');
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
        <div>Amount</div>
        <div>Legs</div>
        <div style="text-align:center">Total Contracts</div>
        <div style="text-align:center">Net Entry</div>
        <div style="text-align:center">Net Current</div>
        <div style="text-align:center">P&L</div>
    `;
    // attach sorting handlers to header labels where appropriate
    header.querySelector('div:nth-child(1)').onclick = () => setStrategiesSort('id');
    header.querySelector('div:nth-child(2)').onclick = () => setStrategiesSort('timestampMsec');
    header.querySelector('div:nth-child(3)').onclick = () => setStrategiesSort('amount');
    header.querySelector('div:nth-child(5)').onclick = () => setStrategiesSort('netSize');
    header.querySelector('div:nth-child(6)').onclick = () => setStrategiesSort('netEntry');
    header.querySelector('div:nth-child(7)').onclick = () => setStrategiesSort('netCurrent');
    header.querySelector('div:nth-child(8)').onclick = () => setStrategiesSort('pnl');

    container.appendChild(header);

    // apply expiry filter
    const expiryFilter = document.getElementById('expiryFilter').value;
    let toRender = parsedStrategies.slice();
    if (expiryFilter && expiryFilter !== 'All') {
        toRender = toRender.filter(s => s.legs.some(l => l.expiry === expiryFilter));
    }

    // compute sort keys and sort
    toRender = toRender.map(s => {
        const netEntry = s.legs.reduce((sum, l) => sum + l.entryPrice * l.size * (l.side === 'buy' ? -1 : 1), 0);
        const netCurrent = s.legs.reduce((sum, l) => sum + ((l.currentPrice != null ? l.currentPrice : 0) * l.size * (l.side === 'buy' ? 1 : -1)), 0);
        const pnl = s.legs.reduce((sum, l) => sum + (l.pnl || 0), 0);
        const netSize = s.legs.reduce((sum, l) => sum + Math.abs(l.size || 0), 0);
        const firstExpiryRaw = s.legs[0]?.expiry || '';
        const firstExpiry = firstExpiryRaw ? parseExpiryToDate(firstExpiryRaw).getTime() : 0;
        const timestampMsec = s.timestamp || 0;
        return Object.assign({}, s, { netEntry, netCurrent, pnl, netSize, firstExpiry, firstExpiryLabel: firstExpiryRaw, timestampMsec });
    });

    const key = strategiesSort.by;
    const dir = strategiesSort.dir;
    toRender.sort((a,b) => {
        const va = (a[key] == null) ? -Infinity : a[key];
        const vb = (b[key] == null) ? -Infinity : b[key];
        if (typeof va === 'string') return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
    });

    // render each strategy as a card with a legs sub-table and a full-width payoff chart below
    toRender.forEach(strategy => {
        const card = document.createElement('div'); card.className = 'strategy-card';

        const top = document.createElement('div'); top.className = 'card-top text-sm text-gray-300';

        const colRFQ = document.createElement('div'); colRFQ.className = 'col-rfq'; colRFQ.innerText = strategy.id;
        const colDate = document.createElement('div'); colDate.className = 'col-date'; colDate.innerText = strategy.timestamp ? new Date(strategy.timestamp + (7*60*60*1000)).toISOString().replace('T',' ').split('.')[0] : '-';
        const colAmount = document.createElement('div'); colAmount.className = 'col-amount'; colAmount.innerText = strategy.amount != null ? Number(strategy.amount).toFixed(2) : '-';

        const colLegs = document.createElement('div'); colLegs.className = 'col-legs';
        const legsTable = document.createElement('table'); legsTable.className = 'card-legs-table';
        const ltHead = document.createElement('thead'); ltHead.innerHTML = '<tr><th>Side</th><th>Type</th><th>Strike</th><th>LegAmt</th><th>Entry</th><th>Current</th><th>PnL</th></tr>';
        const ltBody = document.createElement('tbody');
        strategy.legs.forEach(l => {
            const tr = document.createElement('tr');
            const tdSide = document.createElement('td'); tdSide.innerText = l.side.toUpperCase();
            const tdType = document.createElement('td'); tdType.innerText = l.type;
            const tdStrike = document.createElement('td'); tdStrike.innerText = l.strike;
            const tdAmt = document.createElement('td'); tdAmt.innerText = Number(l.size).toFixed(2);
            const tdEntry = document.createElement('td'); tdEntry.innerText = l.entryPrice != null ? l.entryPrice.toFixed(4) : '-';
            const tdCurrent = document.createElement('td'); tdCurrent.innerText = l.currentPrice != null ? l.currentPrice.toFixed(4) : '-';
            const tdPnl = document.createElement('td'); tdPnl.innerText = l.pnl != null ? l.pnl.toFixed(4) : '-';
            if (l.pnl != null) tdPnl.className = l.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            tr.appendChild(tdSide); tr.appendChild(tdType); tr.appendChild(tdStrike); tr.appendChild(tdAmt); tr.appendChild(tdEntry); tr.appendChild(tdCurrent); tr.appendChild(tdPnl);
            ltBody.appendChild(tr);
        });
        legsTable.appendChild(ltHead); legsTable.appendChild(ltBody);
        colLegs.appendChild(legsTable);

        const colNetSize = document.createElement('div'); colNetSize.className = 'col-netsize'; colNetSize.style.textAlign = 'center'; colNetSize.innerText = Number(strategy.netSize || 0).toFixed(2);
        const colNetEntry = document.createElement('div'); colNetEntry.className = 'col-netentry'; colNetEntry.innerText = (strategy.netEntry != null) ? strategy.netEntry.toFixed(4) : '-';
        const colNetCurrent = document.createElement('div'); colNetCurrent.className = 'col-netcurrent'; colNetCurrent.innerText = (strategy.netCurrent != null) ? strategy.netCurrent.toFixed(4) : '-';
        const colPnl = document.createElement('div'); colPnl.className = 'col-pnl'; colPnl.innerText = (strategy.pnl != null) ? strategy.pnl.toFixed(4) : '-'; if (strategy.pnl != null) colPnl.classList.add(strategy.pnl >= 0 ? 'pnl-positive' : 'pnl-negative');

        top.appendChild(colRFQ); top.appendChild(colDate); top.appendChild(colAmount); top.appendChild(colLegs); top.appendChild(colNetSize); top.appendChild(colNetEntry); top.appendChild(colNetCurrent); top.appendChild(colPnl);

        const payoffRow = document.createElement('div'); payoffRow.className = 'payoff-row';
        const canvas = document.createElement('canvas'); canvas.id = `payoff_full_${strategy.id}`;
        canvas.style.width = '100%'; canvas.style.height = '160px';
        payoffRow.appendChild(canvas);

        card.appendChild(top);
        card.appendChild(payoffRow);
        container.appendChild(card);

        setTimeout(() => renderPayoffMiniChart(strategy, canvas), 20);
    });
}

function renderPayoffMiniChart(strategy, canvas) {
    try {
        // determine strike range from legs
        const strikes = strategy.legs.map(l => l.strike);
        const Kmin = Math.min(...strikes);
        const Kmax = Math.max(...strikes);
        const start = Math.max(0, Math.round(Kmin * 0.6));
        const end = Math.round(Kmax * 1.6) || (Kmax + 10);
        const steps = 50;
        const step = Math.max(1, Math.round((end - start) / steps));
        const labels = [];
        const data = [];

        for (let S = start; S <= end; S += step) {
            labels.push(S);
            let net = 0;
            strategy.legs.forEach(leg => {
                const intrinsic = (leg.type === 'Call') ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
                const legNet = (leg.side === 'buy') ? (intrinsic - leg.entryPrice) * leg.size : -(intrinsic - leg.entryPrice) * leg.size;
                net += legNet;
            });
            data.push(net);
        }

        // eslint-disable-next-line no-unused-vars
        // add a zero-profit baseline dataset so charts show the zero line
        const zeroData = labels.map(() => 0);
        const mini = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [
                { data: zeroData, borderColor: '#9ca3af', borderWidth: 1, pointRadius: 0, borderDash: [4,4], fill: false, tension: 0, order: 0 },
                { data, borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: 'rgba(96,165,250,0.08)', order: 1 }
            ] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
        });
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

    // build current view (same logic as renderStrategiesTable)
    const expiryFilter = document.getElementById('expiryFilter').value;
    let toRender = parsedStrategies.slice();
    if (expiryFilter && expiryFilter !== 'All') {
        toRender = toRender.filter(s => s.legs.some(l => l.expiry === expiryFilter));
    }

    toRender = toRender.map(s => {
        const netEntry = s.legs.reduce((sum, l) => sum + l.entryPrice * l.size * (l.side === 'buy' ? -1 : 1), 0);
        const netCurrent = s.legs.reduce((sum, l) => sum + ((l.currentPrice != null ? l.currentPrice : 0) * l.size * (l.side === 'buy' ? 1 : -1)), 0);
        const pnl = s.legs.reduce((sum, l) => sum + (l.pnl || 0), 0);
        const netSize = s.legs.reduce((sum, l) => sum + Math.abs(l.size || 0), 0);
        const firstExpiryRaw = s.legs[0]?.expiry || '';
        const firstExpiry = firstExpiryRaw ? parseExpiryToDate(firstExpiryRaw).getTime() : 0;
        const timestampMsec = s.timestamp || 0;
        return Object.assign({}, s, { netEntry, netCurrent, pnl, netSize, firstExpiry, firstExpiryLabel: firstExpiryRaw, timestampMsec });
    });

    const key = strategiesSort.by;
    const dir = strategiesSort.dir;
    toRender.sort((a,b) => {
        const va = (a[key] == null) ? -Infinity : a[key];
        const vb = (b[key] == null) ? -Infinity : b[key];
        if (typeof va === 'string') return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
    });

    // build CSV rows
    const rows = toRender.map(s => {
        const legsText = s.legs.map(l => `${l.instrument}|${l.strike}|${l.type}|${l.side}|${l.ratio}|${Number(l.size).toFixed(2)}|${l.entryPrice}|${(l.currentPrice!=null?l.currentPrice:'')}|${(l.pnl!=null?l.pnl:'')}`).join(' ; ');
        const dateUtc7 = s.timestamp ? new Date(s.timestamp + (7*60*60*1000)).toISOString().replace('T', ' ').split('.')[0] : '';
        return {
            RFQ: s.id,
            Date: dateUtc7,
            Timestamp: s.timestamp || '',
            Expiry: s.firstExpiryLabel || '',
            NetSize: Number(s.netSize || 0).toFixed(2),
            NetEntry: (s.netEntry != null) ? s.netEntry.toFixed(4) : '',
            NetCurrent: (s.netCurrent != null) ? s.netCurrent.toFixed(4) : '',
            PnL: (s.pnl != null) ? s.pnl.toFixed(4) : '',
            LegCount: s.legs.length,
            Legs: legsText
        };
    });

    // CSV header
    const header = ['RFQ','Date','Timestamp','Expiry','NetSize','NetEntry','NetCurrent','PnL','LegCount','Legs'];
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

