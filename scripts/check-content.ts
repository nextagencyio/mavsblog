/**
 * Check if there's enough new forum content to generate an article.
 * Outputs GitHub Actions variables: should_generate and recent_posts.
 */

import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(process.cwd(), 'data')
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')

const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf-8'))
const existingPosts = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md') && f !== 'welcome.md')

// Count posts from the last 3 days
const now = Date.now()
const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000)
let recentPosts = 0

for (const thread of data.threads) {
  for (const post of thread.posts) {
    const match = post.dateString.match(/(\d{2})-(\d{2})-(\d{4})/)
    if (!match) {
      recentPosts++ // today/yesterday/ago
      continue
    }
    const d = new Date(`${match[3]}-${match[1]}-${match[2]}`)
    if (d.getTime() > threeDaysAgo) recentPosts++
  }
}

// Only generate if 20+ recent posts (enough for a quality article)
const shouldGenerate = recentPosts >= 20

console.error(`Recent posts (last 3 days): ${recentPosts}`)
console.error(`Existing articles: ${existingPosts.length}`)
console.error(`Should generate: ${shouldGenerate}`)

// Output for GitHub Actions
console.log(`should_generate=${shouldGenerate}`)
console.log(`recent_posts=${recentPosts}`)
