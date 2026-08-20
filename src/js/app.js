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
