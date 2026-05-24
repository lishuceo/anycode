#!/usr/bin/env node
// 从 NateScarlet/holiday-cn 抓取中国法定节假日数据，写入 src/cron/holidays/data/{year}.json
//
// 用法:
//   node scripts/fetch-holidays.mjs            # 抓取当年和明年
//   node scripts/fetch-holidays.mjs 2027       # 抓取指定年份
//   node scripts/fetch-holidays.mjs 2026 2027  # 抓取多个年份
//
// 国务院通常每年 11-12 月发布次年节假日通知。如果远端还是空 days[]，
// 说明数据尚未公布，本地兜底逻辑 (fail-open) 会按非节假日处理。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cron', 'holidays', 'data');
const BASE_URL = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master';

async function fetchYear(year) {
  const url = `${BASE_URL}/${year}.json`;
  process.stdout.write(`Fetching ${url} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAILED (${res.status})`);
    return false;
  }
  const data = await res.json();
  if (data.year !== year) {
    console.log(`SKIP (file year=${data.year}, expected ${year})`);
    return false;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${year}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 4) + '\n');
  console.log(`OK (${data.days?.length ?? 0} days) → ${outPath}`);
  return true;
}

async function main() {
  const argYears = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));
  const years = argYears.length > 0
    ? argYears
    : [new Date().getFullYear(), new Date().getFullYear() + 1];

  let ok = 0;
  for (const year of years) {
    if (await fetchYear(year)) ok += 1;
  }
  console.log(`\nDone. ${ok}/${years.length} years updated.`);
  process.exit(ok === years.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
