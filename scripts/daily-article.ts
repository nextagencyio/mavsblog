/**
 * Daily Article Generator
 *
 * Picks the single best article to generate from scraped forum data,
 * based on what hasn't been covered yet and what has the most engagement.
 * Generates exactly 1 article per run.
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'
import Groq from 'groq-sdk'

dotenv.config()

const DATA_DIR = path.join(process.cwd(), 'data')
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const ASSETS_DIR = path.join(process.cwd(), 'src', 'assets', 'thumbnails')
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

const FORMATS = ['listicle', 'narrative', 'roundup', 'hot-takes', 'point-counterpoint', 'faq'] as const
type Format = typeof FORMATS[number]

const FORMAT_INSTRUCTIONS: Record<Format, string> = {
  'listicle': `FORMAT: Write as a LISTICLE with numbered items (## 1. Title, ## 2. Title). Each item is a specific move, player, or proposal. Brief intro, then numbered list with blockquotes and commentary.`,
  'narrative': `FORMAT: Write as a NARRATIVE story with a beginning, middle, and end. Build tension, use scene-setting. Blockquotes as dramatic moments.`,
  'roundup': `FORMAT: Write as a ROUNDUP with clear section headers (## Topic Name). Each section 2-3 paragraphs with at least one blockquote. Hit the best moment from each topic.`,
  'hot-takes': `FORMAT: Write as RANKED HOT TAKES. Rank the best/wildest takes, starting with honorable mentions building to #1. Use headers like "## #3:", etc.`,
  'point-counterpoint': `FORMAT: Write as POINT/COUNTERPOINT. Structure with "## The Case For" and "## The Case Against" sections with supporting quotes. End with "## The Verdict" where you weigh in.`,
  'faq': `FORMAT: Write as an FAQ with questions as headers (## Q: Question?) followed by answers weaving in community quotes. Questions should be things a fan would actually ask.`,
}

interface ScrapedPost {
  username: string; uid: number; pid: number; tid: number;
  message: string; dateString: string; isTopPoster: boolean;
  profileUrl: string; postUrl: string;
}

interface ScrapedThread {
  tid: number; title: string; type: 'sticky' | 'normal';
  url: string; posts: ScrapedPost[]; totalPosts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function selectPosts(posts: ScrapedPost[], max: number = 20): ScrapedPost[] {
  const top = posts.filter(p => p.isTopPoster)
  const others = posts.filter(p => !p.isTopPoster)
  return [...top.slice(0, Math.ceil(max * 0.6)), ...others.slice(0, Math.floor(max * 0.4))].slice(0, max)
}

function buildContributorsSection(posts: ScrapedPost[]): string {
  const seen = new Map<string, ScrapedPost>()
  for (const p of posts) {
    if (p.username !== 'Unknown' && !seen.has(p.username)) seen.set(p.username, p)
  }
  const lines = ['## Community Contributors', '', 'Thanks to these MavsBoard members whose posts contributed to this article:', '']
  for (const c of seen.values()) {
    lines.push(`- [**${c.username}**](${c.profileUrl})`)
  }
  return lines.join('\n')
}

function buildSourcePostsSection(posts: ScrapedPost[]): string {
  const byThread = new Map<number, ScrapedPost[]>()
  for (const p of posts) {
    const existing = byThread.get(p.tid) || []
    existing.push(p)
    byThread.set(p.tid, existing)
  }
  const lines = ['## Read the Full Discussions', '']
  for (const [tid, threadPosts] of byThread) {
    const threadUrl = `https://www.mavsboard.com/showthread.php?tid=${tid}`
    const postLinks = threadPosts.slice(0, 5).map(p => `[${p.username}'s post](${p.postUrl})`)
    lines.push(`- [View thread](${threadUrl}) — ${postLinks.join(' | ')}`)
  }
  return lines.join('\n')
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) { console.error('GROQ_API_KEY required'); process.exit(1) }

  const groq = new Groq({ apiKey })

  // Load scraped data
  const raw = await fs.readFile(path.join(DATA_DIR, 'latest.json'), 'utf-8')
  const data = JSON.parse(raw)
  const threads: ScrapedThread[] = data.threads

  // Get existing article slugs to avoid duplicates
  const existingFiles = await fs.readdir(CONTENT_DIR)
  const existingSlugs = new Set(existingFiles.map(f => f.replace(/\.md$/, '')))

  console.log('Daily Article Generator')
  console.log(`  Forum data: ${data.stats.totalPosts} posts from ${threads.length} threads`)
  console.log(`  Existing articles: ${existingSlugs.size}`)

  // Find the thread with the most recent activity that hasn't been covered
  // Score each thread by: recent posts * engagement * not-yet-covered
  const today = new Date().toISOString().split('T')[0]
  const candidates: { thread: ScrapedThread; score: number; slug: string; format: Format }[] = []

  for (const thread of threads) {
    if (thread.posts.length < 5) continue

    // Generate a slug for this thread
    const slug = `${today}-${thread.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 50)}`

    // Check if we already have a recent article about this topic
    const titleWords = thread.title.toLowerCase().split(/\s+/)
    const alreadyCovered = [...existingSlugs].some(existing => {
      const matchCount = titleWords.filter(w => w.length > 3 && existing.includes(w)).length
      return matchCount >= 2
    })

    if (alreadyCovered) continue

    // Score: posts * top-poster ratio
    const topPosterRatio = thread.posts.filter(p => p.isTopPoster).length / thread.posts.length
    const score = thread.posts.length * (1 + topPosterRatio)

    // Pick best format based on content
    let format: Format = 'narrative'
    const titleLower = thread.title.toLowerCase()
    if (titleLower.includes('trade') || titleLower.includes('fa ') || titleLower.includes('free agent')) format = 'listicle'
    else if (titleLower.includes('game')) format = 'narrative'
    else if (titleLower.includes('tank') || titleLower.includes('draft') || titleLower.includes('lottery')) format = 'faq'
    else if (titleLower.includes('news') || titleLower.includes('around')) format = 'roundup'
    else if (thread.posts.length > 50) format = 'roundup'

    candidates.push({ thread, score, slug, format })
  }

  if (candidates.length === 0) {
    console.log('  No uncovered threads with enough content. Skipping.')
    return
  }

  // Pick the highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score)
  const pick = candidates[0]

  console.log(`  Selected: "${pick.thread.title}" (${pick.thread.posts.length} posts, score: ${pick.score.toFixed(1)})`)
  console.log(`  Format: ${pick.format}`)
  console.log(`  Slug: ${pick.slug}`)

  // Generate the article
  const selected = selectPosts(pick.thread.posts)
  const postsText = selected
    .map(p => `**${p.username}** (${p.dateString}):\n${p.message.substring(0, 600)}`)
    .join('\n\n---\n\n')

  const userMap = new Map<string, string>()
  for (const p of selected) {
    if (p.username !== 'Unknown') userMap.set(p.username, p.profileUrl)
  }
  const userMapStr = [...userMap.entries()].map(([n, u]) => `${n}: ${u}`).join('\n')

  const formatGuide = FORMAT_INSTRUCTIONS[pick.format]

  const prompt = `You write for MavsBoard Blog. You're a Mavs fan yourself — you have opinions, you're funny, and you write like you're texting your basketball-obsessed friend group, not writing a term paper.

${formatGuide}

CONTEXT: Write an article about this MavsBoard forum discussion: "${pick.thread.title}"

FORUM POSTS FROM THE COMMUNITY:
${postsText}

USER PROFILE LINKS — link usernames as markdown links like [cow](url):
${userMapStr}

WRITING RULES:
- Write 500-900 words
- Sound like a real fan, not a robot. Have a VOICE. Take sides sometimes. Be funny.
- Use short punchy paragraphs. Mix up sentence length.
- IMPORTANT: Include at least 4-6 markdown blockquotes (> "quote"). Pull the juiciest lines directly from the posts.
- Link usernames to their profiles when you mention them
- NEVER use: "let's dive in", "one thing is certain", "it's clear that", "passionate and engaged", "buckle up", "whether or not"
- Don't summarize every post — pick the 4-6 best takes and build around them
- End on something memorable — a hot take, a prediction, a funny line

Format your response EXACTLY as:
HEADLINE: [something catchy and specific]
DESCRIPTION: [1 punchy sentence under 155 chars for SEO]
---
[article body in markdown, NO h1 heading]`

  console.log('  Generating article...')
  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: GROQ_MODEL,
    temperature: 0.85,
    max_tokens: 2500,
  })

  const response = completion.choices[0]?.message?.content || ''
  const headlineMatch = response.match(/HEADLINE:\s*(.+)/)
  const descMatch = response.match(/DESCRIPTION:\s*(.+)/)
  const parts = response.split(/^---$/m)
  let body = parts.length > 1 ? parts.slice(1).join('---').trim() : response
  body = body.replace(/^HEADLINE:.*\n?/gm, '').replace(/^DESCRIPTION:.*\n?/gm, '').trim()

  const headline = headlineMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || pick.thread.title
  const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || `MavsBoard fans discuss: ${pick.thread.title}`

  const contributors = buildContributorsSection(selected)
  const sourcePosts = buildSourcePostsSection(selected)

  const displayTag = pick.thread.type === 'sticky' ? 'featured' : 'discussion'
  const fileContent = `---
title: "${headline.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "${pick.thread.url}"
tags: ["${displayTag}"]
---

${body}

---

${contributors}

${sourcePosts}

*This article is curated from community discussions on [MavsBoard Forum](${pick.thread.url}). [Join the community](https://www.mavsboard.com/member.php?action=register) and share your take!*
`

  await fs.mkdir(CONTENT_DIR, { recursive: true })
  const filePath = path.join(CONTENT_DIR, `${pick.slug}.md`)
  await fs.writeFile(filePath, fileContent)
  console.log(`  ✅ Article saved: ${pick.slug}.md`)
  console.log(`  Title: ${headline}`)
}

main().catch(console.error)
