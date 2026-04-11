/**
 * Generate all articles from scraped forum data
 *
 * Splits large threads into topic clusters and generates
 * focused articles from each cluster.
 */

import fs from 'fs/promises'
import path from 'path'
import Groq from 'groq-sdk'

const DATA_DIR = path.join(process.cwd(), 'data')
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

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

interface ArticlePlan {
  id: string
  headline: string
  prompt: string
  posts: ScrapedPost[]
  forumUrl: string
  tags: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildPostsText(posts: ScrapedPost[], max: number = 20): string {
  // Prioritize top posters
  const top = posts.filter(p => p.isTopPoster)
  const others = posts.filter(p => !p.isTopPoster)
  const selected = [
    ...top.slice(0, Math.ceil(max * 0.6)),
    ...others.slice(0, Math.floor(max * 0.4)),
  ].slice(0, max)

  return selected
    .map(p => `**${p.username}** (${p.dateString}):\n${p.message.substring(0, 600)}`)
    .join('\n\n---\n\n')
}

async function planArticles(threads: ScrapedThread[]): Promise<ArticlePlan[]> {
  const plans: ArticlePlan[] = []
  const forumUrl = 'https://www.mavsboard.com'

  // ── MAVS NEWS: Split into 2-3 weekly chunks ──
  const mavsNews = threads.find(t => t.title.includes('MAVS NEWS'))
  if (mavsNews && mavsNews.posts.length >= 10) {
    // Split by rough date ranges
    const posts = mavsNews.posts
    const chunk1 = posts.filter(p => p.dateString.match(/04-(0[7-9]|1[0-1])-2026/) || p.dateString.includes('Today') || p.dateString.includes('Yesterday') || p.dateString.includes('ago'))
    const chunk2 = posts.filter(p => p.dateString.match(/0[34]-(2[5-9]|30|31|0[1-6])-2026/))
    const chunk3 = posts.filter(p => p.dateString.match(/03-(1[2-9]|2[0-4])-2026/))

    if (chunk1.length >= 5) {
      plans.push({
        id: 'mavs-news-this-week',
        headline: '',
        prompt: `Write a Mavs news roundup article covering the latest Dallas Mavericks news and fan reactions from this week. The Mavs are in a rebuild year (24-52 record), Cooper Flagg is having a historic rookie season, and the team is positioning for the 2026 NBA Draft lottery.`,
        posts: chunk1,
        forumUrl: mavsNews.url,
        tags: ['news', 'featured'],
      })
    }
    if (chunk2.length >= 5) {
      plans.push({
        id: 'mavs-news-late-march',
        headline: '',
        prompt: `Write a Mavs news roundup covering late March / early April Dallas Mavericks news and fan reactions. Cover trade deadline aftermath, injury updates, and roster moves.`,
        posts: chunk2,
        forumUrl: mavsNews.url,
        tags: ['news'],
      })
    }
    if (chunk3.length >= 5) {
      plans.push({
        id: 'mavs-news-mid-march',
        headline: '',
        prompt: `Write a Mavs news roundup covering mid-March Dallas Mavericks news and fan reactions.`,
        posts: chunk3,
        forumUrl: mavsNews.url,
        tags: ['news'],
      })
    }
  }

  // ── TRADE & FA: Split into trade vs free agency topics ──
  const tradeFa = threads.find(t => t.title.includes('Trade & FA'))
  if (tradeFa && tradeFa.posts.length >= 10) {
    // Posts about Kyrie
    const kyriePosts = tradeFa.posts.filter(p =>
      p.message.toLowerCase().includes('kyrie') || p.message.toLowerCase().includes('irving')
    )
    const capPosts = tradeFa.posts.filter(p =>
      p.message.toLowerCase().includes('cap') || p.message.toLowerCase().includes('salary') ||
      p.message.toLowerCase().includes('contract') || p.message.toLowerCase().includes('sign')
    )
    const generalTrade = tradeFa.posts.filter(p =>
      !kyriePosts.includes(p) && !capPosts.includes(p)
    )

    if (kyriePosts.length >= 5) {
      plans.push({
        id: 'kyrie-future-debate',
        headline: '',
        prompt: `Write an article about the MavsBoard community debate over Kyrie Irving's future with the Dallas Mavericks. Kyrie tore his ACL and the fanbase is divided on whether to trade him for draft picks or keep him as a veteran leader for Cooper Flagg's development. Cover both sides of the debate.`,
        posts: kyriePosts,
        forumUrl: tradeFa.url,
        tags: ['trade-rumors', 'featured'],
      })
    }
    if (capPosts.length >= 5) {
      plans.push({
        id: 'offseason-cap-space',
        headline: '',
        prompt: `Write an article about how MavsBoard fans are analyzing the Dallas Mavericks' salary cap situation and free agency plans for the 2026 offseason. The Mavs are ~$38M below the luxury tax. Cover what moves fans are proposing.`,
        posts: capPosts,
        forumUrl: tradeFa.url,
        tags: ['offseason', 'salary-cap'],
      })
    }
    if (generalTrade.length >= 5) {
      plans.push({
        id: 'trade-rumors-roundup',
        headline: '',
        prompt: `Write an article summarizing the latest trade rumors and proposals being discussed on MavsBoard. What trades are fans proposing? What assets do they want to move or acquire?`,
        posts: generalTrade,
        forumUrl: tradeFa.url,
        tags: ['trade-rumors'],
      })
    }
  }

  // ── AROUND THE NBA ──
  const aroundNba = threads.find(t => t.title.includes('AROUND the NBA'))
  if (aroundNba && aroundNba.posts.length >= 10) {
    plans.push({
      id: 'around-the-nba',
      headline: '',
      prompt: `Write an article about what's happening around the NBA from a Mavs fan perspective. These are MavsBoard community members discussing league-wide news, other teams' moves, and how it all affects Dallas. Cover the most interesting discussions and hot takes.`,
      posts: aroundNba.posts,
      forumUrl: aroundNba.url,
      tags: ['nba', 'analysis'],
    })
  }

  // ── NEXT GM WATCH ──
  const gmWatch = threads.find(t => t.title.includes('Next GM'))
  if (gmWatch && gmWatch.posts.length >= 10) {
    plans.push({
      id: 'next-gm-watch',
      headline: '',
      prompt: `Write an article about the MavsBoard community's discussion of who should be the next Dallas Mavericks GM/President of Basketball Operations. Cover the candidates fans are proposing, what qualities they want, and the debate over the front office direction.`,
      posts: gmWatch.posts,
      forumUrl: gmWatch.url,
      tags: ['front-office', 'featured'],
    })
  }

  // ── TANK WATCH ──
  const tankWatch = threads.find(t => t.title.toLowerCase().includes('tank'))
  if (tankWatch && tankWatch.posts.length >= 5) {
    plans.push({
      id: 'tank-watch',
      headline: '',
      prompt: `Write an article about the MavsBoard tank watch discussion. The Mavs are 24-52 and positioning for the 2026 NBA Draft lottery. Cover the debate between fans who embrace the tank and those who want to see competitive basketball, draft lottery odds, and which prospects fans are eyeing.`,
      posts: tankWatch.posts,
      forumUrl: tankWatch.url,
      tags: ['draft', 'tank-watch'],
    })
  }

  // ── GAME RECAPS: Batch recent game threads ──
  const gameThreads = threads.filter(t =>
    t.type === 'normal' && t.title.toLowerCase().includes('game') && t.posts.length >= 5
  )
  if (gameThreads.length >= 2) {
    // Batch into groups of 2-3 games
    for (let i = 0; i < gameThreads.length; i += 3) {
      const batch = gameThreads.slice(i, i + 3)
      const allPosts = batch.flatMap(t =>
        t.posts.map(p => ({ ...p, message: `[Re: ${t.title}] ${p.message}` }))
      )
      const gameNames = batch.map(t => {
        const match = t.title.match(/vs?\.\s*(.+?)(?:\s*\(|\s*\||$)/)
        return match ? match[1].trim() : t.title
      })

      plans.push({
        id: `game-recaps-${i}`,
        headline: '',
        prompt: `Write a game recap roundup article covering these Dallas Mavericks games from MavsBoard fan reactions: ${gameNames.join(', ')}. The Mavs are in a rebuild year so focus on player development, Cooper Flagg's play, and what fans noticed. Cover the highs, lows, and best fan takes from each game.`,
        posts: allPosts,
        forumUrl: batch[0].url,
        tags: ['game-recap'],
      })
    }
  }

  // ── 3-POINT DUNK (fun opinion piece) ──
  const funThread = threads.find(t => t.title.includes('3 Point Dunk'))
  if (funThread && funThread.posts.length >= 3) {
    plans.push({
      id: 'three-point-dunk-rule',
      headline: '',
      prompt: `Write a fun, lighthearted article about MavsBoard's debate over a hypothetical "3-Point Dunk" NBA rule. This is a fun thread where fans are debating a creative rule change. Keep it entertaining and highlight the funniest/most creative takes.`,
      posts: funThread.posts,
      forumUrl: funThread.url,
      tags: ['fun', 'opinion'],
    })
  }

  // ── WEEKLY DIGEST ──
  const allTopPosts = threads
    .flatMap(t => t.posts.filter(p => p.isTopPoster).slice(0, 5))
    .slice(0, 25)

  plans.push({
    id: 'weekly-digest',
    headline: '',
    prompt: `Write a "MavsBoard Weekly Roundup" covering the hottest discussions from the Dallas Mavericks fan forum this week. Topics include: ${threads.map(t => t.title).join(', ')}. Hit the highlights from each, quote the most interesting community members, and keep it conversational.`,
    posts: allTopPosts,
    forumUrl: 'https://www.mavsboard.com',
    tags: ['weekly-digest', 'featured'],
  })

  return plans
}

async function generateArticle(groq: Groq, plan: ArticlePlan): Promise<void> {
  const postsText = buildPostsText(plan.posts)

  const prompt = `You are a sports blogger writing for MavsBoard Blog (blog.mavsboard.com), the official blog of a Dallas Mavericks fan community forum. The forum has passionate, knowledgeable fans who have been discussing Mavs basketball for years.

CONTEXT: ${plan.prompt}

FORUM POSTS FROM THE COMMUNITY:
${postsText}

Write a compelling blog article. Requirements:
1. Create an engaging, SEO-friendly headline
2. Write 500-900 words
3. Quote or reference specific community members by username — they are the stars
4. Add context a casual NBA fan would need
5. Conversational, community-driven tone — not ESPN formal
6. End with an invitation to join MavsBoard forum
7. Focus on the most insightful takes, not just recapping

Format your response EXACTLY as:
HEADLINE: [your headline]
DESCRIPTION: [1 sentence, under 155 chars, for SEO]
---
[article body in markdown, NO h1 heading — the title is added separately]`

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: GROQ_MODEL,
    temperature: 0.7,
    max_tokens: 2500,
  })

  const response = completion.choices[0]?.message?.content || ''

  const headlineMatch = response.match(/HEADLINE:\s*(.+)/)
  const descMatch = response.match(/DESCRIPTION:\s*(.+)/)
  const parts = response.split(/^---$/m)
  const body = parts.length > 1 ? parts.slice(1).join('---').trim() : response

  const headline = headlineMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || plan.id
  const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || `MavsBoard community discusses Mavericks basketball`

  const today = new Date().toISOString().split('T')[0]
  const slug = plan.id

  const fileContent = `---
title: "${headline.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: "${new Date().toISOString()}"
forumUrl: "${plan.forumUrl}"
tags: [${plan.tags.map(t => `"${t}"`).join(', ')}]
---

${body}

---

*This article is curated from community discussions on [MavsBoard Forum](${plan.forumUrl}). Join the conversation and share your take!*
`

  const filePath = path.join(CONTENT_DIR, `${today}-${slug}.md`)
  await fs.writeFile(filePath, fileContent)
  console.log(`  ✅ "${headline}"`)
  console.log(`     → ${path.basename(filePath)}`)
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    console.error('GROQ_API_KEY required')
    process.exit(1)
  }

  const groq = new Groq({ apiKey })

  // Load scraped data
  const raw = await fs.readFile(path.join(DATA_DIR, 'latest.json'), 'utf-8')
  const data = JSON.parse(raw)

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     MavsBoard Article Generator                        ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`  Data: ${data.stats.totalPosts} posts from ${data.stats.totalThreads} threads`)
  console.log()

  // Plan articles
  const plans = await planArticles(data.threads)
  console.log(`  Planned ${plans.length} articles:`)
  for (const p of plans) {
    console.log(`    - [${p.id}] ${p.posts.length} posts, tags: ${p.tags.join(', ')}`)
  }
  console.log()

  // Generate each article
  await fs.mkdir(CONTENT_DIR, { recursive: true })

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    console.log(`  [${i + 1}/${plans.length}] Generating: ${plan.id}`)
    try {
      await generateArticle(groq, plan)
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`)
    }
    if (i < plans.length - 1) await sleep(3000) // rate limit
  }

  console.log()
  console.log(`  ✅ Done! ${plans.length} articles generated in src/content/blog/`)
  console.log(`  Run 'npm run dev' to preview, or 'npm run build' to build for production.`)
}

main().catch(console.error)
