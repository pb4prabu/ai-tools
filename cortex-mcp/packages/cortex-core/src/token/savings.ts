import type { SafeFS } from '../security/fs-guard.js'
import path from 'node:path'

interface SavingsRecord {
  totalTokensSaved: number
  totalQueries: number
  lastUpdated: string
}

/**
 * Tracks token savings across sessions.
 * Persists to .cortex/savings.json.
 */
export class SavingsTracker {
  private record: SavingsRecord = {
    totalTokensSaved: 0,
    totalQueries: 0,
    lastUpdated: new Date().toISOString(),
  }
  private sessionTokensSaved = 0
  private sessionQueries = 0
  private safeFs: SafeFS

  constructor(safeFs: SafeFS) {
    this.safeFs = safeFs
    this.loadSync()
  }

  private loadSync(): void {
    const savingsPath = path.join(this.safeFs.getCortexDir(), 'savings.json')
    try {
      const data = this.safeFs.readFileSync(savingsPath)
      this.record = JSON.parse(data)
    } catch {
      // No existing savings file — start fresh
    }
  }

  /**
   * Track a token saving from a single tool call.
   */
  trackSaving(tokensSaved: number): void {
    this.sessionTokensSaved += tokensSaved
    this.sessionQueries++
    this.record.totalTokensSaved += tokensSaved
    this.record.totalQueries++
    this.record.lastUpdated = new Date().toISOString()
    this.persistAsync()
  }

  getSessionTokensSaved(): number {
    return this.sessionTokensSaved
  }

  getSessionQueries(): number {
    return this.sessionQueries
  }

  getAllTimeTokensSaved(): number {
    return this.record.totalTokensSaved
  }

  getAllTimeQueries(): number {
    return this.record.totalQueries
  }

  private persistAsync(): void {
    const savingsPath = path.join(this.safeFs.getCortexDir(), 'savings.json')
    try {
      this.safeFs.writeFileSync(savingsPath, JSON.stringify(this.record, null, 2))
    } catch {
      // Non-critical — don't crash on persistence failure
    }
  }
}
