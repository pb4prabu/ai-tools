import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { countTokens, estimateTokensFromBytes } from '../counter.js'
import { SavingsTracker } from '../savings.js'
import { SafeFS } from '../../security/fs-guard.js'

describe('token counter', () => {
  it('counts tokens in text', () => {
    const count = countTokens('public class OrderService implements CreateOrderUseCase')
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(20)
  })

  it('returns 0 for empty text', () => {
    expect(countTokens('')).toBe(0)
  })

  it('counts more tokens for longer text', () => {
    const short = countTokens('hello')
    const long = countTokens('hello world this is a longer sentence with more tokens')
    expect(long).toBeGreaterThan(short)
  })

  it('estimates from bytes', () => {
    const estimate = estimateTokensFromBytes(400)
    expect(estimate).toBe(100)
  })
})

describe('SavingsTracker', () => {
  let tmpDir: string
  let safeFs: SafeFS

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-savings-'))
    // Create .condex directory for savings.json
    fs.mkdirSync(path.join(tmpDir, '.condex'), { recursive: true })
    safeFs = new SafeFS(tmpDir)
  })

  it('tracks session savings', () => {
    const tracker = new SavingsTracker(safeFs)
    tracker.trackSaving(100)
    tracker.trackSaving(200)

    expect(tracker.getSessionTokensSaved()).toBe(300)
    expect(tracker.getSessionQueries()).toBe(2)
  })

  it('persists all-time savings', () => {
    const tracker1 = new SavingsTracker(safeFs)
    tracker1.trackSaving(500)

    // Create new tracker — should load persisted data
    const tracker2 = new SavingsTracker(safeFs)
    expect(tracker2.getAllTimeTokensSaved()).toBe(500)
    expect(tracker2.getSessionTokensSaved()).toBe(0)

    tracker2.trackSaving(300)
    expect(tracker2.getAllTimeTokensSaved()).toBe(800)
  })

  it('handles missing savings file gracefully', () => {
    const tracker = new SavingsTracker(safeFs)
    expect(tracker.getAllTimeTokensSaved()).toBe(0)
    expect(tracker.getSessionTokensSaved()).toBe(0)
  })
})
