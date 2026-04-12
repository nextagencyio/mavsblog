/**
 * This Week in Mavs Blogs
 *
 * Pulls recent posts from major Mavs fan blogs via RSS feeds
 * and generates a roundup article using Groq.
 *
 * Usage:
 *   npx tsx scripts/blogs-roundup.ts
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'
import Groq from 'groq-sdk'

dotenv.config()

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const GROQ_MODEL = 'openai/gpt-oss-120b'
const DAYS_BACK = 7

const FEEDS: { name: string; url: string }[] = [
  { name: 'Mavs Moneyball', url: 'https://www.mavsmoneyball.com/rss/index.xml' },
  { name: 'The Smoking Cuban', url: 'https://thesmokingcuban.com/feed' },
  { name: 'Hoops Rumors (Mavericks)', url: 'https://www.hoopsrumors.com/dallas-mavericks/feed' },
]

interface BlogPost {
  source: string
  title: string
  link: string
  pubDate: Date
  summary: string
}

function decodeHtml(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, '...')
    .replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&nbsp;/g, ' ')
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function parseAtomFeed(xml: string, source: string): BlogPost[] {
  const posts: BlogPost[] = []
  // Atom uses <entry> tags
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]
    const titleMatch = entry.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/)
    const dateMatch = entry.match(/<published[^>]*>([^<]+)<\/published>/) || entry.match(/<updated[^>]*>([^<]+)<\/updated>/)
    const summaryMatch = entry.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/) || entry.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/)

    if (titleMatch && linkMatch && dateMatch) {
      posts.push({
        source,
        title: stripHtml(titleMatch[1]),
        link: linkMatch[1],
        pubDate: new Date(dateMatch[1]),
        summary: summaryMatch ? stripHtml(summaryMatch[1]).substring(0, 600) : '',
      })
    }
  }
  return posts
}

function parseRssFeed(xml: string, source: string): BlogPost[] {
  const posts: BlogPost[] = []
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1]
    const titleMatch = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)
    const linkMatch = item.match(/<link[^>]*>([^<]+)<\/link>/)
    const dateMatch = item.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/)
    const descMatch = item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) ||
                      item.match(/<content:encoded[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/)

    if (titleMatch && linkMatch && dateMatch) {
      posts.push({
        source,
        title: stripHtml(titleMatch[1]),
        link: linkMatch[1].trim(),
        pubDate: new Date(dateMatch[1]),
        summary: descMatch ? stripHtml(descMatch[1]).substring(0, 600) : '',
      })
    }
  }
  return posts
}

async function fetchFeed(name: string, url: string): Promise<BlogPost[]> {
  console.log(`  Fetching ${name}...`)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MavsBoardBlog/1.0' },
    })
    if (!response.ok) {
      console.log(`    ⚠️  ${response.status}`)
      return []
    }
    const xml = await response.text()
    // Try Atom first, then RSS
    let posts = parseAtomFeed(xml, name)
    if (posts.length === 0) {
      posts = parseRssFeed(xml, name)
    }
    console.log(`    ✓ ${posts.length} posts`)
    return posts
  } catch (err: any) {
    console.log(`    ❌ ${err.message}`)
    return []
  }
}

async function generateArticle(groq: Groq, posts: BlogPost[]): Promise<{ headline: string; description: string; body: string }> {
  // Group posts by source
  const bySource = new Map<string, BlogPost[]>()
  for (const post of posts) {
    const list = bySource.get(post.source) || []
    list.push(post)
    bySource.set(post.source, list)
  }

  const sourceContent = [...bySource.entries()].map(([source, posts]) => {
    return `=== ${source} (${posts.length} posts) ===\n\n` + posts.map(p =>
      `TITLE: ${p.title}\nURL: ${p.link}\nDATE: ${p.pubDate.toISOString().split('T')[0]}\nSUMMARY: ${p.summary}`
    ).join('\n\n')
  }).join('\n\n\n')

  const prompt = `You're writing a "This Week in Mavs Blogs" roundup article for MavsBoard Blog. Below are recent posts from major Dallas Mavericks fan blogs and news sites.

YOUR JOB:
- Group the highlights by source (Mavs Moneyball, The Smoking Cuban, Hoops Rumors, etc.)
- For each source, pick the 3-5 most interesting/important posts to highlight
- Give each post a brief 1-2 sentence summary in your own words
- Always link to the original article using markdown links: [Title](URL)
- Use ## headers for each blog source
- Write in a casual, fun, fan-blog tone — but keep it brief and informative
- Cap each item at 50-80 words of summary

ATTRIBUTION (CRITICAL):
- Always link back to the original article so readers can read the full piece on the source site
- Mention the source name when discussing posts
- This is a CURATION, not stealing — we're pointing people to other Mavs blogs

LENGTH: 700-1000 words total

Format your response EXACTLY as:
HEADLINE: [Catchy headline like "This Week in Mavs Blogs: [top theme]"]
DESCRIPTION: [1 sentence under 155 chars summarizing the week]
---
[article body in markdown with ## headers per blog source]

BLOG POSTS TO COVER:
${sourceContent}`

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: GROQ_MODEL,
    temperature: 0.7,
    max_tokens: 3000,
  })

  const response = completion.choices[0]?.message?.content || ''
  const headlineMatch = response.match(/HEADLINE:\s*\*?\*?\s*(.+)/)
  const descMatch = response.match(/DESCRIPTION:\s*\*?\*?\s*(.+)/)
  const parts = response.split(/^---$/m)
  let body = parts.length > 1 ? parts.slice(1).join('---').trim() : response
  body = body
    .replace(/^\*?\*?HEADLINE:?\*?\*?[^\n]*\n+/gm, '')
    .replace(/^\*?\*?DESCRIPTION:?\*?\*?[^\n]*\n+/gm, '')
    .replace(/^\s*---\s*\n+/, '')
    .trim()

  return {
    headline: headlineMatch?.[1]?.trim().replace(/^[*"']+|[*"']+$/g, '').trim() || 'This Week in Mavs Blogs',
    description: descMatch?.[1]?.trim().replace(/^[*"']+|[*"']+$/g, '').trim() || 'A roundup of the top Dallas Mavericks blog posts this week.',
    body,
  }
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) { console.error('GROQ_API_KEY required'); process.exit(1) }
  const groq = new Groq({ apiKey })

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     Mavs Blogs Roundup Generator                       ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // Fetch all feeds
  const allPosts: BlogPost[] = []
  for (const feed of FEEDS) {
    const posts = await fetchFeed(feed.name, feed.url)
    allPosts.push(...posts)
  }

  // Filter to last 7 days
  const cutoff = Date.now() - (DAYS_BACK * 24 * 60 * 60 * 1000)
  const recentPosts = allPosts.filter(p => p.pubDate.getTime() > cutoff)
  console.log(`\n  Total recent posts (last ${DAYS_BACK} days): ${recentPosts.length}`)

  if (recentPosts.length < 3) {
    console.log('  Not enough recent content. Skipping.')
    return
  }

  // Sort by date desc
  recentPosts.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())

  // Cap to top 30 posts to keep prompt manageable
  const posts = recentPosts.slice(0, 30)

  console.log(`  Generating roundup article with Groq...`)
  const article = await generateArticle(groq, posts)

  // Save to blog
  const today = new Date().toISOString().split('T')[0]
  const slug = `${today}-this-week-in-mavs-blogs`
  const filePath = path.join(CONTENT_DIR, `${slug}.md`)

  const sourceList = [...new Set(posts.map(p => p.source))].join(', ')

  const fileContent = `---
title: "${article.headline.replace(/"/g, '\\"')}"
description: "${article.description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "https://www.mavsboard.com"
tags: ["blogs-roundup", "weekly"]
---

${article.body}

---

*This roundup links to the original articles from ${sourceList}. All credit goes to the original authors and publishers. Click through to support these great Mavs writers.*
`

  await fs.mkdir(CONTENT_DIR, { recursive: true })
  await fs.writeFile(filePath, fileContent)
  console.log(`\n  ✅ Article saved: ${slug}.md`)
  console.log(`  Title: ${article.headline}`)
}

main().catch(console.error)
