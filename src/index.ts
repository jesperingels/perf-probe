#!/usr/bin/env ts-node

/**
 * TTFB Performance Monitor
 *
 * Measures Time To First Byte (TTFB) for a given URL over a configurable period.
 * Outputs results to console, JSON file, and generates an HTML report with a chart.
 *
 * Usage:
 *   npm run test -- --url https://example.com --duration 20 --interval 10
 *
 * Options:
 *   --url       URL to test (required)
 *   --duration  Duration in minutes (default: 20)
 *   --interval  Interval between tests in seconds (default: 10)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

// Get results directory relative to project root
const projectRoot = path.resolve(__dirname, '..');
const resultsDir = path.join(projectRoot, 'results');

interface Measurement {
    timestamp: string;
    ttfb: number;
    statusCode: number | null;
    cacheStatus: string | null;
    error: string | null;
}

interface TestResults {
    url: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    intervalSeconds: number;
    measurements: Measurement[];
    stats: {
        count: number;
        min: number;
        max: number;
        average: number;
        median: number;
        p95: number;
        successRate: number;
    };
}

// Parse command line arguments
function parseArgs(): { url: string; duration: number; interval: number } {
    const args = process.argv.slice(2);
    let url = '';
    let duration = 20;
    let interval = 10;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
                url = args[++i];
                break;
            case '--duration':
                duration = parseFloat(args[++i]);
                break;
            case '--interval':
                interval = parseFloat(args[++i]);
                break;
        }
    }

    if (!url) {
        console.error('❌ Error: --url is required');
        console.log(
            '\nUsage: npm run test -- --url <url> [--duration <minutes>] [--interval <seconds>]',
        );
        process.exit(1);
    }

    return { url, duration, interval };
}

// Measure TTFB for a single request
function measureTTFB(url: string): Promise<Measurement> {
    return new Promise((resolve) => {
        const timestamp = new Date().toISOString();
        const startTime = performance.now();
        let ttfbRecorded = false;

        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const req = protocol.request(
            url,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'TTFB-Monitor/1.0',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
            },
            (res) => {
                if (!ttfbRecorded) {
                    const ttfb = performance.now() - startTime;
                    ttfbRecorded = true;

                    // Get x-nextjs-cache header
                    const cacheStatus = res.headers['x-nextjs-cache'] as string | undefined;

                    // Consume response to free up the connection
                    res.on('data', () => {});
                    res.on('end', () => {
                        resolve({
                            timestamp,
                            ttfb: Math.round(ttfb * 100) / 100,
                            statusCode: res.statusCode ?? null,
                            cacheStatus: cacheStatus ?? null,
                            error: null,
                        });
                    });
                }
            },
        );

        req.on('error', (err) => {
            resolve({
                timestamp,
                ttfb: -1,
                statusCode: null,
                cacheStatus: null,
                error: err.message,
            });
        });

        req.setTimeout(45000, () => {
            req.destroy();
            resolve({
                timestamp,
                ttfb: -1,
                statusCode: null,
                cacheStatus: null,
                error: 'Request timeout (45s)',
            });
        });

        req.end();
    });
}

// Calculate statistics from measurements
function calculateStats(measurements: Measurement[]): TestResults['stats'] {
    const successfulMeasurements = measurements.filter((m) => m.ttfb > 0);
    const ttfbValues = successfulMeasurements.map((m) => m.ttfb).sort((a, b) => a - b);

    if (ttfbValues.length === 0) {
        return {
            count: measurements.length,
            min: 0,
            max: 0,
            average: 0,
            median: 0,
            p95: 0,
            successRate: 0,
        };
    }

    const sum = ttfbValues.reduce((a, b) => a + b, 0);
    const median =
        ttfbValues.length % 2 === 0
            ? (ttfbValues[ttfbValues.length / 2 - 1] + ttfbValues[ttfbValues.length / 2]) / 2
            : ttfbValues[Math.floor(ttfbValues.length / 2)];
    const p95Index = Math.ceil(ttfbValues.length * 0.95) - 1;

    return {
        count: measurements.length,
        min: Math.round(Math.min(...ttfbValues) * 100) / 100,
        max: Math.round(Math.max(...ttfbValues) * 100) / 100,
        average: Math.round((sum / ttfbValues.length) * 100) / 100,
        median: Math.round(median * 100) / 100,
        p95: Math.round(ttfbValues[p95Index] * 100) / 100,
        successRate:
            Math.round((successfulMeasurements.length / measurements.length) * 100 * 100) / 100,
    };
}

// Generate HTML report with Chart.js
function generateHtmlReport(results: TestResults): string {
    const labels = results.measurements.map((m) =>
        new Date(m.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }),
    );
    const data = results.measurements.map((m) => (m.ttfb > 0 ? m.ttfb : null));
    const cacheData = results.measurements.map((m) => m.cacheStatus);

    // Calculate cache statistics
    const cacheStats = results.measurements.reduce((acc, m) => {
        const status = m.cacheStatus || 'none';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTFB Performance Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap');

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --bg-primary: #0a0a0f;
            --bg-secondary: #12121a;
            --bg-card: #1a1a24;
            --text-primary: #e8e8ed;
            --text-secondary: #8b8b9a;
            --accent: #6366f1;
            --accent-glow: rgba(99, 102, 241, 0.3);
            --success: #22c55e;
            --warning: #f59e0b;
            --danger: #ef4444;
            --border: rgba(255, 255, 255, 0.08);
        }

        body {
            font-family: 'Space Grotesk', -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 2rem;
            background-image:
                radial-gradient(ellipse at 20% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
                radial-gradient(ellipse at 80% 100%, rgba(139, 92, 246, 0.1) 0%, transparent 50%);
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        header {
            text-align: center;
            margin-bottom: 3rem;
        }

        h1 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            background: linear-gradient(135deg, var(--text-primary), var(--accent));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .subtitle {
            color: var(--text-secondary);
            font-size: 1rem;
            font-family: 'JetBrains Mono', monospace;
            word-break: break-all;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.25rem;
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .stat-card.highlight {
            border-color: var(--accent);
            box-shadow: 0 0 24px var(--accent-glow);
        }

        .stat-label {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
        }

        .stat-value {
            font-size: 1.75rem;
            font-weight: 600;
            font-family: 'JetBrains Mono', monospace;
        }

        .stat-unit {
            font-size: 0.875rem;
            color: var(--text-secondary);
            margin-left: 0.25rem;
        }

        .chart-container {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 1.5rem;
            margin-bottom: 2rem;
        }

        .chart-wrapper {
            position: relative;
            height: 400px;
        }

        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
        }

        .info-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
        }

        .info-card h3 {
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--text-secondary);
            margin-bottom: 1rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 0.5rem 0;
            font-size: 0.9rem;
        }

        .info-row .label {
            color: var(--text-secondary);
        }

        .info-row .value {
            font-family: 'JetBrains Mono', monospace;
            color: var(--text-primary);
        }

        .cache-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-family: 'JetBrains Mono', monospace;
        }
        
        .cache-hit { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .cache-stale { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
        .cache-miss { background: rgba(239, 68, 68, 0.15); color: var(--danger); }

        footer {
            text-align: center;
            margin-top: 3rem;
            padding-top: 2rem;
            border-top: 1px solid var(--border);
            color: var(--text-secondary);
            font-size: 0.875rem;
        }
        
        footer a {
            color: var(--accent);
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>TTFB Performance Report</h1>
            <p class="subtitle">${results.url}</p>
        </header>

        <div class="stats-grid">
            <div class="stat-card highlight">
                <div class="stat-label">Average TTFB</div>
                <div class="stat-value">${results.stats.average}<span class="stat-unit">ms</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${results.stats.min}<span class="stat-unit">ms</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${results.stats.max}<span class="stat-unit">ms</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Median</div>
                <div class="stat-value">${results.stats.median}<span class="stat-unit">ms</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">P95</div>
                <div class="stat-value">${results.stats.p95}<span class="stat-unit">ms</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Success Rate</div>
                <div class="stat-value">${results.stats.successRate}<span class="stat-unit">%</span></div>
            </div>
        </div>

        <div class="chart-container">
            <div class="chart-wrapper">
                <canvas id="ttfbChart"></canvas>
            </div>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <h3>Test Configuration</h3>
                <div class="info-row">
                    <span class="label">Duration</span>
                    <span class="value">${results.durationMinutes} minutes</span>
                </div>
                <div class="info-row">
                    <span class="label">Interval</span>
                    <span class="value">${results.intervalSeconds} seconds</span>
                </div>
                <div class="info-row">
                    <span class="label">Total Measurements</span>
                    <span class="value">${results.stats.count}</span>
                </div>
            </div>
            <div class="info-card">
                <h3>Cache Statistics (x-nextjs-cache)</h3>
                ${Object.entries(cacheStats).map(([status, count]) => `
                <div class="info-row">
                    <span class="label"><span class="cache-badge cache-${status.toLowerCase()}">${status.toUpperCase()}</span></span>
                    <span class="value">${count} (${Math.round(count / results.stats.count * 100)}%)</span>
                </div>`).join('')}
            </div>
            <div class="info-card">
                <h3>Timestamps</h3>
                <div class="info-row">
                    <span class="label">Start</span>
                    <span class="value">${new Date(results.startTime).toLocaleString()}</span>
                </div>
                <div class="info-row">
                    <span class="label">End</span>
                    <span class="value">${new Date(results.endTime).toLocaleString()}</span>
                </div>
            </div>
        </div>

        <footer>
            <p>Generated by <a href="https://github.com/your-username/ttfb-performance-monitor" target="_blank">TTFB Performance Monitor</a></p>
        </footer>
    </div>

    <script>
        const ctx = document.getElementById('ttfbChart').getContext('2d');

        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
        gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
        
        const cacheData = ${JSON.stringify(cacheData)};
        const cacheColors = cacheData.map(status => {
            if (status === 'HIT') return '#22c55e';
            if (status === 'STALE') return '#f59e0b';
            if (status === 'MISS') return '#ef4444';
            return '#6366f1';
        });

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(labels)},
                datasets: [{
                    label: 'TTFB (ms)',
                    data: ${JSON.stringify(data)},
                    borderColor: '#6366f1',
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    pointBackgroundColor: cacheColors,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    spanGaps: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(26, 26, 36, 0.95)',
                        titleColor: '#e8e8ed',
                        bodyColor: '#e8e8ed',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: function(context) {
                                const cache = cacheData[context.dataIndex] || '-';
                                return context.parsed.y !== null 
                                    ? ['TTFB: ' + context.parsed.y + ' ms', 'Cache: ' + cache]
                                    : 'Error';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#8b8b9a',
                            font: {
                                family: "'JetBrains Mono', monospace",
                                size: 11
                            },
                            maxRotation: 45,
                            minRotation: 45
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#8b8b9a',
                            font: {
                                family: "'JetBrains Mono', monospace",
                                size: 11
                            },
                            callback: function(value) {
                                return value + ' ms';
                            }
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>`;
}

// Main execution
async function main() {
    const { url, duration, interval } = parseArgs();
    const totalTests = Math.floor((duration * 60) / interval);
    const measurements: Measurement[] = [];

    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│              TTFB Performance Monitor                   │');
    console.log('└─────────────────────────────────────────────────────────┘\n');
    console.log(`  🌐 URL:      ${url}`);
    console.log(`  ⏱️  Duration: ${duration} minutes`);
    console.log(`  🔄 Interval: ${interval} seconds`);
    console.log(`  📊 Tests:    ${totalTests} measurements\n`);
    console.log('─'.repeat(75));
    console.log('  #     Time          TTFB        Cache       Status');
    console.log('─'.repeat(75));

    const startTime = new Date().toISOString();
    const endTimeMs = Date.now() + duration * 60 * 1000;

    let testNumber = 0;

    while (Date.now() < endTimeMs) {
        testNumber++;
        const measurement = await measureTTFB(url);
        measurements.push(measurement);

        const time = new Date(measurement.timestamp).toLocaleTimeString('en-US');
        const ttfbStr = measurement.ttfb > 0 ? `${measurement.ttfb.toFixed(2)} ms` : 'ERROR';
        const cacheStr = measurement.cacheStatus ?? '-';
        const statusStr = measurement.error
            ? `❌ ${measurement.error}`
            : `✅ ${measurement.statusCode}`;

        console.log(
            `  ${testNumber.toString().padStart(3)}   ${time}   ${ttfbStr.padStart(10)}   ${cacheStr.padEnd(10)}  ${statusStr}`,
        );

        // Wait for next interval (if not the last test)
        if (Date.now() < endTimeMs) {
            await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
    }

    const endTime = new Date().toISOString();
    const stats = calculateStats(measurements);

    console.log('\n' + '─'.repeat(75));
    console.log('\n📊 Statistics:\n');
    console.log(`   Average:   ${stats.average} ms`);
    console.log(`   Minimum:   ${stats.min} ms`);
    console.log(`   Maximum:   ${stats.max} ms`);
    console.log(`   Median:    ${stats.median} ms`);
    console.log(`   P95:       ${stats.p95} ms`);
    console.log(`   Success:   ${stats.successRate}%`);

    // Create results object
    const results: TestResults = {
        url,
        startTime,
        endTime,
        durationMinutes: duration,
        intervalSeconds: interval,
        measurements,
        stats,
    };

    // Create results folder with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runDir = path.join(resultsDir, timestamp);

    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }
    fs.mkdirSync(runDir);

    // Save JSON results
    const jsonPath = path.join(runDir, 'results.json');
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results saved: ${jsonPath}`);

    // Generate HTML report
    const htmlPath = path.join(runDir, 'report.html');
    fs.writeFileSync(htmlPath, generateHtmlReport(results));
    console.log(`📈 HTML report: ${htmlPath}`);

    console.log('\n✨ Test completed!\n');
}

main().catch(console.error);

