/**
 * MavsBoard Blog Post Generator
 *
 * Scrapes top forum threads from MavsBoard.com and uses Groq AI
 * to generate blog posts from the community discussions.
 *
 * Usage:
 *   npx tsx scripts/generate-posts.ts                    # Generate weekly digest
 *   npx tsx scripts/generate-posts.ts --type digest      # Weekly digest
 *   npx tsx scripts/generate-posts.ts --type thread 4022 # Single thread post
 *   npx tsx scripts/generate-posts.ts --type trending    # Trending topics
 *
 * Environment:
 *   GROQ_API_KEY     — Groq API key (required)
 *   MYBB_DB_HOST     — MyBB database host (optional, for direct DB access)
 *   MYBB_DB_USER     — MyBB database user
 *   MYBB_DB_PASS     — MyBB database password
 *   MYBB_DB_NAME     — MyBB database name
 */

import fs from 'fs/promises'
import path from 'path'
import Groq from 'groq-sdk'

// ── Config ──────────────────────────────────────────────────────────────

const FORUM_URL = 'https://www.mavsboard.com'
const FORUM_ID = 2 // "Dallas Mavericks and the NBA" forum
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')

// ── Types ───────────────────────────────────────────────────────────────

interface ForumThread {
  tid: number
  subject: string
  username: string
  replies: number
  views: number
  lastpost: number
  dateline: number
}

interface ForumPost {
  pid: number
  username: string
  message: string
  dateline: number
}

interface GeneratedPost {
  title: string
  slug: string
  description: string
  content: string
  pubDate: string
  forumThreadId: number
  forumUrl: string
}

// ── Forum Scraper (HTML-based, no DB needed) ────────────────────────────

async function scrapeForumThreads(forumId: number, limit: number = 10): Promise<ForumThread[]> {
  console.log(`  Fetching threads from forum ${forumId}...`)
  const url = `${FORUM_URL}/forumdisplay.php?fid=${forumId}&sortby=lastpost&order=desc`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MavsBoard Blog Generator/1.0' }
  })
  const html = await response.text()

  // Parse thread list from HTML
  const threads: ForumThread[] = []
  const threadRegex = /showthread\.php\?tid=(\d+)[^"]*"[^>]*>([^<]+)/g
  let match
  const seen = new Set<number>()

  while ((match = threadRegex.exec(html)) !== null) {
    const tid = parseInt(match[1])
    if (seen.has(tid)) continue
    seen.add(tid)

    const subject = match[2].trim()
    // Skip sticky/announcement-style threads
    if (subject.toLowerCase().includes('sticky') || subject.toLowerCase().includes('rules')) continue

    threads.push({
      tid,
      subject,
      username: '',
      replies: 0,
      views: 0,
      lastpost: Date.now() / 1000,
      dateline: Date.now() / 1000,
    })

    if (threads.length >= limit) break
  }

  console.log(`  Found ${threads.length} threads`)
  return threads
}

async function scrapeThreadPosts(tid: number, maxPosts: number = 20): Promise<{ subject: string; posts: ForumPost[] }> {
  console.log(`  Fetching posts from thread ${tid}...`)
  const url = `${FORUM_URL}/showthread.php?tid=${tid}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MavsBoard Blog Generator/1.0' }
  })
  const html = await response.text()

  // Get thread title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const subject = titleMatch ? titleMatch[1].trim() : `Thread ${tid}`

  // Parse posts — look for post content divs
  const posts: ForumPost[] = []
  // MyBB wraps post content in <div id="pid_XXXX" class="post">
  const postRegex = /id="post_(\d+)"[\s\S]*?<span class="largetext"><a[^>]*>([^<]+)<\/a><\/span>[\s\S]*?<div class="post_body"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g

  let postMatch
  while ((postMatch = postRegex.exec(html)) !== null && posts.length < maxPosts) {
    const message = postMatch[3]
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (message.length > 20) {
      posts.push({
        pid: parseInt(postMatch[1]),
        username: postMatch[2].trim(),
        message,
        dateline: Date.now() / 1000,
      })
    }
  }

  // Fallback: simpler regex if the above didn't match
  if (posts.length === 0) {
    const simpleRegex = /class="post_body"[^>]*>([\s\S]*?)<\/div>/g
    let simpleMatch
    while ((simpleMatch = simpleRegex.exec(html)) !== null && posts.length < maxPosts) {
      const message = simpleMatch[1]
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      if (message.length > 20) {
        posts.push({
          pid: posts.length + 1,
          username: 'Community Member',
          message,
          dateline: Date.now() / 1000,
        })
      }
    }
  }

  console.log(`  Found ${posts.length} posts in "${subject}"`)
  return { subject, posts }
}

// ── Groq AI Content Generation ──────────────────────────────────────────

async function generateBlogPost(
  groq: Groq,
  threadData: { subject: string; posts: ForumPost[]; tid: number },
  type: 'thread' | 'digest'
): Promise<GeneratedPost> {
  const postsText = threadData.posts
    .slice(0, 15)
    .map(p => `${p.username}: ${p.message.substring(0, 500)}`)
    .join('\n\n---\n\n')

  const prompt = type === 'thread'
    ? `You are a sports blogger for MavsBoard.com, a Dallas Mavericks fan community.
Write a blog post based on this forum discussion thread titled "${threadData.subject}".

Here are the forum posts from the community:

${postsText}

Write an engaging blog post that:
1. Summarizes the key points and opinions from the discussion
2. Highlights the most interesting takes and debates
3. Adds context for casual fans who might not follow every game
4. Is written in a conversational, fan-community tone
5. Is 400-800 words
6. Includes specific quotes or paraphrases from community members (use their usernames)
7. Ends with a call to action to join the discussion on the forum

Return ONLY the blog post content in markdown format. Do not include a title heading — that will be added separately.`
    : `You are a sports blogger for MavsBoard.com, a Dallas Mavericks fan community.
Write a "Weekly Digest" blog post summarizing these top forum discussions:

${postsText}

Write an engaging weekly roundup that:
1. Covers the top 3-5 discussion topics from the week
2. Highlights the hottest takes and most debated topics
3. Is written in a conversational, fan-community tone
4. Is 500-1000 words
5. References specific community members by username
6. Ends by inviting readers to join the discussions on MavsBoard

Return ONLY the blog post content in markdown format. Do not include a title heading.`

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.7,
    max_tokens: 2000,
  })

  const content = completion.choices[0]?.message?.content || ''

  // Generate metadata
  const today = new Date()
  const dateStr = today.toISOString().split('T')[0]
  const slug = threadData.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60)

  const descPrompt = `Write a 1-sentence meta description (under 155 characters) for a blog post titled "${threadData.subject}" about Dallas Mavericks fan discussion. Return ONLY the description, no quotes.`

  const descCompletion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: descPrompt }],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.5,
    max_tokens: 100,
  })

  const description = descCompletion.choices[0]?.message?.content?.trim() ||
    `MavsBoard community discusses: ${threadData.subject}`

  return {
    title: threadData.subject,
    slug: `${dateStr}-${slug}`,
    description,
    content,
    pubDate: today.toISOString(),
    forumThreadId: threadData.tid,
    forumUrl: `${FORUM_URL}/showthread.php?tid=${threadData.tid}`,
  }
}

// ── File Output ─────────────────────────────────────────────────────────

async function savePost(post: GeneratedPost): Promise<string> {
  const frontmatter = `---
title: "${post.title.replace(/"/g, '\\"')}"
description: "${post.description.replace(/"/g, '\\"')}"
pubDate: "${post.pubDate}"
forumUrl: "${post.forumUrl}"
---`

  const fileContent = `${frontmatter}

${post.content}

---

*This post is based on community discussions from [MavsBoard Forum](${post.forumUrl}). Join the conversation!*
`

  const filePath = path.join(CONTENT_DIR, `${post.slug}.md`)
  await fs.mkdir(CONTENT_DIR, { recursive: true })
  await fs.writeFile(filePath, fileContent)
  return filePath
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  let type = 'digest'
  let threadId: number | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) {
      type = args[i + 1]
      i++
    } else if (!args[i].startsWith('--') && !isNaN(parseInt(args[i]))) {
      threadId = parseInt(args[i])
    }
  }

  // Check for API key
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    console.error('GROQ_API_KEY environment variable is required')
    console.error('Get your key at https://console.groq.com/')
    process.exit(1)
  }

  const groq = new Groq({ apiKey })

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     MavsBoard Blog Post Generator                      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  if (type === 'thread' && threadId) {
    // Generate post from a specific thread
    console.log(`Generating post from thread ${threadId}...`)
    const { subject, posts } = await scrapeThreadPosts(threadId)
    if (posts.length === 0) {
      console.error('No posts found in thread')
      process.exit(1)
    }

    console.log('\nGenerating blog post with Groq AI...')
    const post = await generateBlogPost(groq, { subject, posts, tid: threadId }, 'thread')
    const filePath = await savePost(post)
    console.log(`\n✅ Post saved: ${filePath}`)
    console.log(`   Title: ${post.title}`)
    console.log(`   Slug: ${post.slug}`)

  } else if (type === 'digest') {
    // Generate weekly digest from top threads
    console.log('Generating weekly digest...')
    const threads = await scrapeForumThreads(FORUM_ID, 5)

    if (threads.length === 0) {
      console.error('No threads found')
      process.exit(1)
    }

    // Fetch posts from each thread
    const allPosts: ForumPost[] = []
    for (const thread of threads) {
      const { posts } = await scrapeThreadPosts(thread.tid, 5)
      allPosts.push(...posts.map(p => ({ ...p, message: `[${thread.subject}] ${p.message}` })))
      // Rate limit
      await new Promise(r => setTimeout(r, 1000))
    }

    const today = new Date()
    const weekStr = today.toISOString().split('T')[0]

    console.log('\nGenerating digest with Groq AI...')
    const post = await generateBlogPost(
      groq,
      {
        subject: `MavsBoard Weekly Digest - ${weekStr}`,
        posts: allPosts,
        tid: 0,
      },
      'digest'
    )
    post.forumUrl = FORUM_URL

    const filePath = await savePost(post)
    console.log(`\n✅ Digest saved: ${filePath}`)
    console.log(`   Title: ${post.title}`)

  } else {
    console.log('Usage:')
    console.log('  npx tsx scripts/generate-posts.ts --type digest')
    console.log('  npx tsx scripts/generate-posts.ts --type thread 4022')
  }
}

main().catch(console.error)
