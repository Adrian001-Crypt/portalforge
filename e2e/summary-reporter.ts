import { mkdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** Writes docs/test-results/browser-latest.json: titles and outcomes only, no machine paths or traces. */
export default class SummaryReporter implements Reporter {
  private tests: { file: string; title: string; status: string; ms: number }[] = [];
  onTestEnd(t: TestCase, r: TestResult) { this.tests.push({ file: relative(process.cwd(), t.location.file), title: t.title, status: r.status, ms: r.duration }); }
  onEnd(result: FullResult) {
    mkdirSync('docs/test-results', { recursive: true });
    writeFileSync('docs/test-results/browser-latest.json', JSON.stringify({ suite: 'browser', ranAt: new Date().toISOString(), runsAgainst: 'system Chrome, local stack on Anvil; injected test wallet, not MetaMask, not Portaldot', status: result.status, passed: this.tests.filter((t) => t.status === 'passed').length, failed: this.tests.filter((t) => t.status !== 'passed' && t.status !== 'skipped').length, tests: this.tests }, null, 2) + '\n');
  }
}
