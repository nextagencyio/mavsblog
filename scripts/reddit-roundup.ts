/**
 * This Week in Mavs Reddit
 *
 * Pulls top posts from r/Mavericks for the past week and generates
 * a roundup article using Groq. Each item links back to the Reddit thread.
 *
 * Usage:
 *   npx tsx scripts/reddit-roundup.ts
 *   npx tsx scripts/reddit-roundup.ts --limit 15
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'
import Groq from 'groq-sdk'

dotenv.config()

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const GROQ_MODEL = 'openai/gpt-oss-120b'
const SUBREDDIT = 'Mavericks'
const USER_AGENT = 'MavsBoardBlog/1.0 (by /u/mavsboard)'

interface RedditPost {
  id: string
  title: string
  author: string
  permalink: string
  url: string
  selftext: string
  score: number
  num_comments: number
  created_utc: number
  is_self: boolean
}

interface RedditComment {
  author: string
  body: string
  score: number
}

interface RedditThread {
  post: RedditPost
  topComments: RedditComment[]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchTopPosts(limit: number = 15): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${SUBREDDIT}/top.json?t=week&limit=${limit}`
  console.log(`  Fetching top ${limit} posts from r/${SUBREDDIT}...`)

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!response.ok) {
    throw new Error(`Reddit API error: ${response.status}`)
  }
  const data = await response.json() as any

  return data.data.children.map((c: any) => ({
    id: c.data.id,
    title: c.data.title,
    author: c.data.author,
    permalink: `https://www.reddit.com${c.data.permalink}`,
    url: c.data.url,
    selftext: c.data.selftext || '',
    score: c.data.score,
    num_comments: c.data.num_comments,
    created_utc: c.data.created_utc,
    is_self: c.data.is_self,
  }))
}

async function fetchTopComments(postId: string, limit: number = 5): Promise<RedditComment[]> {
  const url = `https://www.reddit.com/r/${SUBREDDIT}/comments/${postId}.json?sort=top&limit=${limit}`

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!response.ok) return []
  const data = await response.json() as any

  // Reddit returns [post, comments]
  const commentsData = data[1]?.data?.children || []
  return commentsData
    .filter((c: any) => c.kind === 't1' && c.data.body && c.data.body !== '[deleted]' && c.data.body !== '[removed]')
    .slice(0, limit)
    .map((c: any) => ({
      author: c.data.author,
      body: c.data.body.substring(0, 500),
      score: c.data.score,
    }))
}

async function generateArticle(groq: Groq, threads: RedditThread[]): Promise<{ headline: string; description: string; body: string }> {
  // Build content for the prompt — strip usernames since we don't want to mention them
  const threadContent = threads.map((t, i) => {
    const post = t.post
    const text = post.selftext ? post.selftext.substring(0, 500) : '[link post]'
    const comments = t.topComments.map(c => c.body.substring(0, 300)).join('\n  ---\n  ')
    return `THREAD ${i + 1}: "${post.title}"
URL: ${post.permalink}
Score: ${post.score} upvotes / ${post.num_comments} comments
Post body: ${text}
Top comments:
  ${comments || '(none)'}`
  }).join('\n\n=====\n\n')

  const prompt = `You're writing a "This Week in r/Mavericks" roundup article for MavsBoard Blog. Below are the top posts from Reddit's r/Mavericks subreddit this week, along with their top comments.

YOUR JOB:
- Summarize what r/Mavericks was talking about this week
- Pick 6-10 of the most interesting/important threads to highlight
- For each, give the title (or a clean version of it), summarize what's being discussed, and quote 1-2 of the top comments
- Write in a casual, fun, fan-blog tone
- Use markdown headers (##) for each thread
- Each highlighted thread should link to the Reddit URL using markdown link syntax in the heading: ## [Thread Title](https://reddit.com/r/Mavericks/...)
- Use blockquotes (> ) for the top comments

ATTRIBUTION:
- Refer to commenters as "one Redditor" or "one user" or "another commenter" — DO NOT use real Reddit usernames
- These are summaries, not your own opinions

LENGTH: 700-1000 words total

Format your response EXACTLY as:
HEADLINE: [Catchy headline like "This Week in r/Mavericks: [top topic]"]
DESCRIPTION: [1 sentence under 155 chars summarizing the week]
---
[article body in markdown]

REDDIT THREADS TO COVER:
${threadContent}`

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: GROQ_MODEL,
    temperature: 0.75,
    max_tokens: 3000,
  })

  const response = completion.choices[0]?.message?.content || ''
  const headlineMatch = response.match(/HEADLINE:\s*\*?\*?\s*(.+)/)
  const descMatch = response.match(/DESCRIPTION:\s*\*?\*?\s*(.+)/)
  const parts = response.split(/^---$/m)
  let body = parts.length > 1 ? parts.slice(1).join('---').trim() : response
  // Strip any leaked HEADLINE/DESCRIPTION lines (with or without bold markdown)
  body = body
    .replace(/^\*?\*?HEADLINE:?\*?\*?[^\n]*\n+/gm, '')
    .replace(/^\*?\*?DESCRIPTION:?\*?\*?[^\n]*\n+/gm, '')
    .replace(/^\s*---\s*\n+/, '')
    .trim()

  return {
    headline: headlineMatch?.[1]?.trim().replace(/^[*"']+|[*"']+$/g, '').trim() || 'This Week in r/Mavericks',
    description: descMatch?.[1]?.trim().replace(/^[*"']+|[*"']+$/g, '').trim() || 'A roundup of the top discussions from r/Mavericks this week.',
    body,
  }
}

async function main() {
  const args = process.argv.slice(2)
  let limit = 15
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1])
      i++
    }
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) { console.error('GROQ_API_KEY required'); process.exit(1) }
  const groq = new Groq({ apiKey })

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     Reddit Mavs Roundup Generator                      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // Fetch top posts
  const posts = await fetchTopPosts(limit)
  console.log(`  Got ${posts.length} top posts`)

  // Fetch top comments for each
  const threads: RedditThread[] = []
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]
    process.stdout.write(`  [${i + 1}/${posts.length}] "${post.title.substring(0, 60)}..." `)
    const comments = await fetchTopComments(post.id, 4)
    console.log(`(${comments.length} comments)`)
    threads.push({ post, topComments: comments })
    await sleep(800) // Reddit rate limit
  }

  // Generate the article
  console.log('\n  Generating roundup article with Groq...')
  const article = await generateArticle(groq, threads)

  // Save to blog
  const today = new Date().toISOString().split('T')[0]
  const slug = `${today}-this-week-in-mavs-reddit`
  const filePath = path.join(CONTENT_DIR, `${slug}.md`)

  const fileContent = `---
title: "${article.headline.replace(/"/g, '\\"')}"
description: "${article.description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "https://www.reddit.com/r/${SUBREDDIT}"
tags: ["reddit-roundup", "weekly"]
---

${article.body}

---

*This roundup is curated from the top posts on [r/Mavericks](https://www.reddit.com/r/${SUBREDDIT}) this week. All credit goes to the original posters and commenters.*
`

  await fs.mkdir(CONTENT_DIR, { recursive: true })
  await fs.writeFile(filePath, fileContent)
  console.log(`\n  ✅ Article saved: ${slug}.md`)
  console.log(`  Title: ${article.headline}`)
}

main().catch(console.error)
