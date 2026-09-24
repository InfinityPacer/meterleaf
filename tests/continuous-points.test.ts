import { expect, test } from "bun:test";
import { continuousPoints } from "../src/web/lib/report";

const hour = 3600000;
const start = Date.parse("2026-09-24T16:00:00Z");
const point = (offset: number, value: number | null, count = 1) => ({
  at: start + offset * hour,
  value,
  count,
  incomplete: value === null ? count : 0,
});

test("empty buckets between reported buckets become known zeros", () => {
  const filled = continuousPoints([point(0, 5), point(3, null, 2)], "hour");
  expect(filled.map((item) => item.at - start)).toEqual([
    0,
    hour,
    2 * hour,
    3 * hour,
  ]);
  expect(filled.map((item) => item.value)).toEqual([5, 0, 0, null]);
  expect(filled.map((item) => item.count)).toEqual([1, 0, 0, 2]);
});

test("buckets outside the reported span stay absent because coverage is unknown", () => {
  expect(continuousPoints([point(2, 5)], "hour")).toEqual([point(2, 5)]);
  expect(continuousPoints([], "day")).toEqual([]);
});

test("day and week buckets use fixed Shanghai spans", () => {
  const day = 24 * hour;
  const daily = continuousPoints(
    [point(0, 1), { ...point(0, 2), at: start + 2 * day }],
    "day",
  );
  expect(daily.map((item) => item.value)).toEqual([1, 0, 2]);
  const weekly = continuousPoints(
    [point(0, 1), { ...point(0, 2), at: start + 14 * day }],
    "week",
  );
  expect(weekly.map((item) => item.value)).toEqual([1, 0, 2]);
});

test("an implausibly long span is returned unchanged instead of allocating", () => {
  const points = [point(0, 1), point(100, 2)];
  expect(continuousPoints(points, "hour", 50)).toEqual(points);
});

test("points off the bucket grid are returned unchanged", () => {
  const points = [point(0, 1), { ...point(0, 2), at: start + 90 * 60000 }];
  expect(continuousPoints(points, "hour")).toEqual(points);
});
