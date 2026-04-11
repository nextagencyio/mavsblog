/**
 * MavsBoard Blog Post Generator v2
 *
 * Phase 1: Scrape and save forum data locally (last 30 days)
 * Phase 2: Use Groq AI to generate blog articles from the data
 *
 * Usage:
 *   npx tsx scripts/generate-posts.ts scrape              # Scrape forum data
 *   npx tsx scripts/generate-posts.ts generate             # Generate articles from scraped data
 *   npx tsx scripts/generate-posts.ts scrape-and-generate  # Both in one run
 *
 * Environment:
 *   GROQ_API_KEY  — Groq API key (required for generate step)
 */

import fs from 'fs/promises'
import path from 'path'
import Groq from 'groq-sdk'

// ── Config ──────────────────────────────────────────────────────────────

const FORUM_URL = 'https://www.mavsboard.com'
const FORUM_ID = 2
const DATA_DIR = path.join(process.cwd(), 'data')
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const DAYS_BACK = 30
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct' // cheap + fast
const DELAY_MS = 1500 // delay between forum page fetches

// Top posters — content from these users gets priority
const TOP_POSTERS = [
  'SleepingHero', 'KillerLeft', 'Kammrath', 'Chicagojk', 'omahen',
  'cow', 'dirkfansince1998', 'ItsGoTime', 'HoosierDaddyKid', 'Mavs2021',
  'ClutchDirk', 'Scott41theMavs', 'mvossman', 'fifteenth', 'DanSchwartzgan',
  'Hypermav', 'F Gump', 'StepBackJay', 'Smitty', 'BigDirk41',
]

// ── Types ───────────────────────────────────────────────────────────────

interface ScrapedPost {
  username: string
  message: string
  dateString: string
  isTopPoster: boolean
}

interface ScrapedThread {
  tid: number
  title: string
  type: 'sticky' | 'normal'
  url: string
  posts: ScrapedPost[]
  totalPosts: number
}

interface ForumData {
  scrapeDate: string
  daysBack: number
  threads: ScrapedThread[]
  topPosters: string[]
  stats: {
    totalThreads: number
    totalPosts: number
    totalFromTopPosters: number
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchHTML(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MavsBoard Blog Generator/2.0' }
  })
  return response.text()
}

function stripHTML(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '[QUOTE]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isWithinDays(dateStr: string, days: number): boolean {
  // MyBB date formats: "04-11-2026, 03:30 PM" or "Yesterday, 03:30 PM" or "Today, 03:30 PM"
  const now = Date.now()
  const cutoff = now - (days * 24 * 60 * 60 * 1000)

  if (dateStr.includes('Today') || dateStr.includes('ago') || dateStr.includes('Yesterday')) {
    return true
  }

  // Try parsing the date
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/)
  if (match) {
    const parsed = new Date(`${match[3]}-${match[1]}-${match[2]}`)
    return parsed.getTime() > cutoff
  }

  return true // if we can't parse, include it
}

// ── Phase 1: Scrape ─────────────────────────────────────────────────────

async function scrapeForumPage(): Promise<{ stickyTids: number[]; normalTids: number[]; threadTitles: Map<number, string> }> {
  console.log('  Fetching forum thread list...')
  const html = await fetchHTML(`${FORUM_URL}/forumdisplay.php?fid=${FORUM_ID}`)

  const stickyTids: number[] = []
  const normalTids: number[] = []
  const threadTitles = new Map<number, string>()

  // Find the line numbers for sticky/normal separators
  const stickyStart = html.indexOf('Important Threads')
  const normalStart = html.indexOf('Normal Threads')

  if (stickyStart === -1 || normalStart === -1) {
    console.log('  Warning: Could not find sticky/normal separators')
    return { stickyTids, normalTids, threadTitles }
  }

  const stickySection = html.substring(stickyStart, normalStart)
  const normalSection = html.substring(normalStart)

  // Extract thread IDs and titles from each section
  const threadRegex = /showthread\.php\?tid=(\d+)">([^<0-9][^<]*)</g

  let match
  const seenSticky = new Set<number>()
  while ((match = threadRegex.exec(stickySection)) !== null) {
    const tid = parseInt(match[1])
    if (!seenSticky.has(tid)) {
      seenSticky.add(tid)
      stickyTids.push(tid)
      threadTitles.set(tid, match[2].replace(/&amp;/g, '&').trim())
    }
  }

  const seenNormal = new Set<number>()
  const normalRegex = /showthread\.php\?tid=(\d+)">([^<0-9][^<]*)/g
  while ((match = normalRegex.exec(normalSection)) !== null) {
    const tid = parseInt(match[1])
    if (!seenNormal.has(tid) && !seenSticky.has(tid)) {
      seenNormal.add(tid)
      normalTids.push(tid)
      threadTitles.set(tid, match[2].replace(/&amp;/g, '&').trim())
    }
  }

  console.log(`  Found ${stickyTids.length} sticky threads, ${normalTids.length} normal threads`)
  return { stickyTids, normalTids, threadTitles }
}

async function scrapeThreadPages(tid: number, title: string, maxPages: number = 10): Promise<ScrapedPost[]> {
  const posts: ScrapedPost[] = []

  // Start from the LAST page and work backwards (most recent posts first)
  // First, get page 1 to find total pages
  const firstPageHtml = await fetchHTML(`${FORUM_URL}/showthread.php?tid=${tid}`)

  // Find total pages from pagination links for this specific thread
  const pageRegex = new RegExp(`tid=${tid}&(?:amp;)?page=(\\d+)`, 'g')
  let maxPage = 1
  let pgMatch
  while ((pgMatch = pageRegex.exec(firstPageHtml)) !== null) {
    const pg = parseInt(pgMatch[1])
    if (pg > maxPage) maxPage = pg
  }
  const totalPages = maxPage
  const startPage = Math.max(1, totalPages - maxPages + 1)

  process.stdout.write(`  Thread ${tid} "${title}" — ${totalPages} pages, scraping ${startPage}-${totalPages}`)

  for (let page = totalPages; page >= startPage; page--) {
    const url = page === 1
      ? `${FORUM_URL}/showthread.php?tid=${tid}`
      : `${FORUM_URL}/showthread.php?tid=${tid}&page=${page}`

    const html = page === 1 && totalPages === 1 ? firstPageHtml : await fetchHTML(url)

    // Parse posts from this page
    // Split on post divs: <div class="post " ... id="post_XXXXX">
    const postBlocks = html.split(/class="post\s+" style="" id="post_\d+"/)
    for (const block of postBlocks.slice(1)) {
      // Extract username — inside <span class="largetext"><a ...><span style="color:...">USERNAME</span></a>
      const usernameMatch = block.match(/class="largetext"><a[^>]*>(?:<span[^>]*>)?([^<]+)/)
      const username = usernameMatch ? usernameMatch[1].trim() : 'Unknown'

      // Extract post body — <div class="post_body scaleimages" id="pid_XXXXX">...</div>
      const bodyMatch = block.match(/class="post_body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*\n?\s*\n?\s*<div class="post_meta"/)
      if (!bodyMatch) continue
      const message = stripHTML(bodyMatch[1])
      if (message.length < 20) continue

      // Extract date — <span class="post_date"><span title="MM-DD-YYYY">Today/Yesterday/date</span>, HH:MM
      const dateMatch = block.match(/class="post_date"><span title="([^"]*)"/)
      const dateString = dateMatch ? dateMatch[1].trim() : ''

      // Check if within our date range
      if (!isWithinDays(dateString, DAYS_BACK)) continue

      posts.push({
        username,
        message: message.substring(0, 2000),
        dateString,
        isTopPoster: TOP_POSTERS.includes(username),
      })
    }

    if (page > startPage) await sleep(DELAY_MS)
  }

  process.stdout.write(` — ${posts.length} posts\n`)
  return posts
}

async function scrapeAllData(): Promise<ForumData> {
  console.log('\n=== Phase 1: Scraping Forum Data ===\n')

  const { stickyTids, normalTids, threadTitles } = await scrapeForumPage()
  await sleep(DELAY_MS)

  const threads: ScrapedThread[] = []

  // Scrape sticky threads (all of them, last 30 days of posts)
  console.log(`\n--- Sticky Threads (${stickyTids.length}) ---\n`)
  for (const tid of stickyTids) {
    const title = threadTitles.get(tid) || `Thread ${tid}`
    const posts = await scrapeThreadPages(tid, title, 15) // up to 15 pages back
    threads.push({
      tid,
      title,
      type: 'sticky',
      url: `${FORUM_URL}/showthread.php?tid=${tid}`,
      posts,
      totalPosts: posts.length,
    })
    await sleep(DELAY_MS)
  }

  // Scrape normal threads (top 10 most recent)
  console.log(`\n--- Normal Threads (top ${Math.min(normalTids.length, 10)}) ---\n`)
  for (const tid of normalTids.slice(0, 10)) {
    const title = threadTitles.get(tid) || `Thread ${tid}`
    const posts = await scrapeThreadPages(tid, title, 5) // up to 5 pages back
    threads.push({
      tid,
      title,
      type: 'normal',
      url: `${FORUM_URL}/showthread.php?tid=${tid}`,
      posts,
      totalPosts: posts.length,
    })
    await sleep(DELAY_MS)
  }

  const totalPosts = threads.reduce((sum, t) => sum + t.posts.length, 0)
  const totalFromTopPosters = threads.reduce(
    (sum, t) => sum + t.posts.filter(p => p.isTopPoster).length, 0
  )

  const data: ForumData = {
    scrapeDate: new Date().toISOString(),
    daysBack: DAYS_BACK,
    threads,
    topPosters: TOP_POSTERS,
    stats: {
      totalThreads: threads.length,
      totalPosts,
      totalFromTopPosters,
    },
  }

  // Save to disk
  await fs.mkdir(DATA_DIR, { recursive: true })
  const filename = `forum-data-${new Date().toISOString().split('T')[0]}.json`
  const filepath = path.join(DATA_DIR, filename)
  await fs.writeFile(filepath, JSON.stringify(data, null, 2))

  // Also save a "latest" symlink-style copy
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(data, null, 2))

  console.log(`\n=== Scrape Complete ===`)
  console.log(`  Threads: ${data.stats.totalThreads}`)
  console.log(`  Posts: ${data.stats.totalPosts}`)
  console.log(`  From top posters: ${data.stats.totalFromTopPosters}`)
  console.log(`  Saved: ${filepath}`)

  return data
}

// ── Phase 2: Generate Articles ──────────────────────────────────────────

async function generateArticles(data: ForumData): Promise<void> {
  console.log('\n=== Phase 2: Generating Articles ===\n')

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    console.error('GROQ_API_KEY required. Set it in .env')
    process.exit(1)
  }

  const groq = new Groq({ apiKey })
  await fs.mkdir(CONTENT_DIR, { recursive: true })

  // Strategy 1: Generate a post for each sticky thread with enough content
  const stickyThreads = data.threads.filter(t => t.type === 'sticky' && t.posts.length >= 5)
  console.log(`  ${stickyThreads.length} sticky threads with enough content`)

  for (const thread of stickyThreads) {
    console.log(`\n  Generating article for: "${thread.title}"`)

    // Prioritize top poster content but include others
    const topPosterPosts = thread.posts.filter(p => p.isTopPoster)
    const otherPosts = thread.posts.filter(p => !p.isTopPoster)

    // Build a balanced selection: 60% top posters, 40% others
    const selectedPosts = [
      ...topPosterPosts.slice(0, 12),
      ...otherPosts.slice(0, 8),
    ]

    const postsText = selectedPosts
      .map(p => `**${p.username}** (${p.dateString}):\n${p.message}`)
      .join('\n\n---\n\n')

    const prompt = `You are a sports blogger writing for MavsBoard Blog (blog.mavsboard.com), the official blog of a Dallas Mavericks fan community forum.

Below are recent posts (last 30 days) from the MavsBoard forum thread titled "${thread.title}". The forum has been around for years and has passionate, knowledgeable Mavs fans.

FORUM POSTS:
${postsText}

Write a compelling blog article based on these discussions. Requirements:
1. Create an engaging headline (not the same as the thread title)
2. Write 500-900 words
3. Summarize the key topics, debates, and opinions from the community
4. Quote or reference specific users by name — they are the stars of the content
5. Add context that a casual NBA fan would need
6. Write in a conversational, community-driven tone — not ESPN formal
7. End with an invitation to join the discussion at mavsboard.com
8. Focus on the most interesting/insightful takes, not just the most recent

Format your response as:
HEADLINE: [your headline]
DESCRIPTION: [1 sentence under 155 chars for SEO meta description]
---
[article body in markdown]`

    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: GROQ_MODEL,
        temperature: 0.7,
        max_tokens: 2500,
      })

      const response = completion.choices[0]?.message?.content || ''

      // Parse headline and description
      const headlineMatch = response.match(/HEADLINE:\s*(.+)/)
      const descMatch = response.match(/DESCRIPTION:\s*(.+)/)
      const bodyMatch = response.split('---').slice(1).join('---').trim()

      const headline = headlineMatch?.[1]?.trim() || thread.title
      const description = descMatch?.[1]?.trim() || `MavsBoard community discusses: ${thread.title}`
      const body = bodyMatch || response

      // Generate slug and save
      const today = new Date().toISOString().split('T')[0]
      const slug = headline
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60)

      const frontmatter = `---
title: "${headline.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "${thread.url}"
tags: ["${thread.type === 'sticky' ? 'featured' : 'discussion'}"]
---`

      const fileContent = `${frontmatter}

${body}

---

*This article is curated from community discussions on [MavsBoard Forum](${thread.url}). Join the conversation and share your take!*
`
      const filePath = path.join(CONTENT_DIR, `${today}-${slug}.md`)
      await fs.writeFile(filePath, fileContent)
      console.log(`  ✅ Saved: ${path.basename(filePath)}`)

    } catch (err: any) {
      console.error(`  ❌ Error generating for "${thread.title}": ${err.message}`)
    }

    await sleep(2000) // rate limit between API calls
  }

  // Strategy 2: Generate a weekly digest from normal threads
  const normalThreads = data.threads.filter(t => t.type === 'normal' && t.posts.length >= 3)
  if (normalThreads.length >= 2) {
    console.log(`\n  Generating weekly digest from ${normalThreads.length} normal threads...`)

    const digestText = normalThreads
      .map(t => {
        const bestPosts = [
          ...t.posts.filter(p => p.isTopPoster).slice(0, 3),
          ...t.posts.filter(p => !p.isTopPoster).slice(0, 2),
        ]
        const postsStr = bestPosts
          .map(p => `  ${p.username}: ${p.message.substring(0, 300)}`)
          .join('\n')
        return `THREAD: "${t.title}" (${t.posts.length} posts)\n${postsStr}`
      })
      .join('\n\n===\n\n')

    const prompt = `You are a sports blogger writing the weekly digest for MavsBoard Blog (blog.mavsboard.com).

Here are the active discussion threads from MavsBoard this week:

${digestText}

Write a "MavsBoard Weekly Roundup" blog post. Requirements:
1. Cover each active thread as a section
2. Write 600-1000 words total
3. Highlight the best takes from community members (use their usernames)
4. Keep it conversational and fun
5. End with a call to join MavsBoard

Format your response as:
HEADLINE: [your headline, e.g. "MavsBoard Weekly: Tank Watch, Draft Dreams, and Cooper Flagg's Latest"]
DESCRIPTION: [1 sentence under 155 chars]
---
[article body in markdown]`

    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: GROQ_MODEL,
        temperature: 0.7,
        max_tokens: 2500,
      })

      const response = completion.choices[0]?.message?.content || ''
      const headlineMatch = response.match(/HEADLINE:\s*(.+)/)
      const descMatch = response.match(/DESCRIPTION:\s*(.+)/)
      const body = response.split('---').slice(1).join('---').trim()

      const headline = headlineMatch?.[1]?.trim() || 'MavsBoard Weekly Roundup'
      const description = descMatch?.[1]?.trim() || 'This week on MavsBoard: the hottest Mavs discussions'

      const today = new Date().toISOString().split('T')[0]
      const slug = `weekly-roundup-${today}`

      const fileContent = `---
title: "${headline.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "${FORUM_URL}"
tags: ["weekly-digest"]
---

${body}

---

*This weekly roundup is curated from the hottest discussions on [MavsBoard Forum](${FORUM_URL}). Join the community!*
`
      const filePath = path.join(CONTENT_DIR, `${slug}.md`)
      await fs.writeFile(filePath, fileContent)
      console.log(`  ✅ Digest saved: ${path.basename(filePath)}`)
    } catch (err: any) {
      console.error(`  ❌ Error generating digest: ${err.message}`)
    }
  }

  console.log('\n=== Generation Complete ===')
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2] || 'scrape-and-generate'

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     MavsBoard Blog Post Generator v2                   ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  if (command === 'scrape') {
    await scrapeAllData()
  } else if (command === 'generate') {
    // Load latest scraped data
    const dataPath = path.join(DATA_DIR, 'latest.json')
    try {
      const raw = await fs.readFile(dataPath, 'utf-8')
      const data: ForumData = JSON.parse(raw)
      console.log(`  Loaded data from ${data.scrapeDate} (${data.stats.totalPosts} posts)`)
      await generateArticles(data)
    } catch {
      console.error(`No scraped data found at ${dataPath}. Run 'scrape' first.`)
      process.exit(1)
    }
  } else if (command === 'scrape-and-generate') {
    const data = await scrapeAllData()
    await generateArticles(data)
  } else {
    console.log('Usage:')
    console.log('  npx tsx scripts/generate-posts.ts scrape')
    console.log('  npx tsx scripts/generate-posts.ts generate')
    console.log('  npx tsx scripts/generate-posts.ts scrape-and-generate')
  }
}

main().catch(console.error)
