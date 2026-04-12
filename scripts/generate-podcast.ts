/**
 * MavsBoard Weekly Podcast Generator
 *
 * Pipeline:
 * 1. Load scraped forum data
 * 2. Use Groq LLM to write a punchy podcast script (8-12 min)
 * 3. Split script into chunks (TTS has practical limits)
 * 4. Generate audio for each chunk via Groq Orpheus
 * 5. Stitch chunks together with ffmpeg, convert to MP3
 * 6. Save as a podcast episode
 *
 * Usage:
 *   npx tsx scripts/generate-podcast.ts                  # Full pipeline
 *   npx tsx scripts/generate-podcast.ts --script-only    # Just write the script
 *   npx tsx scripts/generate-podcast.ts --voice hannah   # Override voice
 */

import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import dotenv from 'dotenv'
import Groq from 'groq-sdk'

dotenv.config()

const execAsync = promisify(exec)

const DATA_DIR = path.join(process.cwd(), 'data')
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const PODCAST_DIR = path.join(process.cwd(), 'public', 'podcast')
const SCRIPT_DIR = path.join(process.cwd(), 'data', 'podcast-scripts')
const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b'
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english'
const DEFAULT_VOICE = 'troy'
const CHUNK_TARGET_CHARS = 800 // chunks of ~800 chars (~8 sec of audio each)
const BLOG_URL = 'https://blog.mavsboard.com'

interface ScrapedPost {
  username: string; uid: number; pid: number; tid: number;
  message: string; dateString: string; isTopPoster: boolean;
  profileUrl: string; postUrl: string;
}

interface ScrapedThread {
  tid: number; title: string; type: 'sticky' | 'normal';
  url: string; posts: ScrapedPost[]; totalPosts: number;
}

function selectPosts(posts: ScrapedPost[], max: number = 30): ScrapedPost[] {
  const top = posts.filter(p => p.isTopPoster)
  const others = posts.filter(p => !p.isTopPoster)
  return [...top.slice(0, Math.ceil(max * 0.7)), ...others.slice(0, Math.floor(max * 0.3))].slice(0, max)
}

interface BlogArticle {
  title: string
  description: string
  body: string
}

async function loadRecentArticles(daysBack: number = 7): Promise<BlogArticle[]> {
  const files = await fs.readdir(CONTENT_DIR)
  const articles: BlogArticle[] = []
  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000)

  for (const file of files) {
    if (!file.endsWith('.md') && !file.endsWith('.mdx')) continue
    if (file === 'welcome.md') continue

    const content = await fs.readFile(path.join(CONTENT_DIR, file), 'utf-8')
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) continue

    const frontmatter = fmMatch[1]
    let body = fmMatch[2]

    // Parse pubDate
    const dateMatch = frontmatter.match(/pubDate:\s*"([^"]+)"/)
    if (dateMatch) {
      const pubDate = new Date(dateMatch[1]).getTime()
      if (pubDate < cutoff) continue
    }

    const titleMatch = frontmatter.match(/title:\s*"([^"]+)"/)
    const descMatch = frontmatter.match(/description:\s*"([^"]+)"/)

    // Strip the contributor section, source posts, and CTA from the body
    body = body.split(/^## Community Contributors/m)[0]
    body = body.split(/^## Read the Full Discussions/m)[0]

    // Remove usernames inside markdown links to mavsboard profiles
    // [username](https://www.mavsboard.com/member.php...) → "a fan"
    body = body.replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?mavsboard\.com\/member[^)]*\)/g, 'a fan')

    // Remove other markdown links but keep the text: [text](url) -> text
    body = body.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Remove blockquote markers but keep the text
    body = body.replace(/^>\s*/gm, '')

    // Replace "fan" / "fans" with "guy" / "guys" so the model doesn't copy them
    body = body.replace(/\bfans\b/gi, 'guys')
    body = body.replace(/\bfan\b/gi, 'guy')
    body = body.replace(/\bMavs guys\b/gi, 'MavsBoard nation')
    body = body.replace(/\bMavs guy\b/gi, 'one of us')

    // Clean up
    body = body.replace(/\n{3,}/g, '\n\n').trim()

    articles.push({
      title: titleMatch?.[1] || file,
      description: descMatch?.[1] || '',
      body,
    })
  }

  return articles
}

async function generateScript(groq: Groq): Promise<string> {
  const articles = await loadRecentArticles(7)
  console.log(`  Loaded ${articles.length} articles from the last 7 days`)

  if (articles.length === 0) {
    throw new Error('No recent articles to base the podcast on')
  }

  const allContent = articles
    .map((a, i) => `ARTICLE ${i + 1}: "${a.title}"\n${a.description}\n\n${a.body}`)
    .join('\n\n=====\n\n')

  const prompt = `You're the host of "MavsBoard Weekly," a quick-paced Dallas Mavericks weekly roundup podcast. You're funny, casual, and energetic, but your job this week is to give listeners a fast, accurate rundown of what's been published on the blog this week — basically a "here's what you missed" summary so they're caught up.

Think of it like a sports radio "headlines" segment crossed with a friend texting you "ok here's everything that happened this week."

THE FORMAT (CRITICAL):
- Open with energy: "Hey Mavs sickos, welcome back to MavsBoard Weekly, your weekly rundown of everything happening on MavsBoard Blog. Let's catch you up."
- For EACH article below, give a quick segment (75-150 words each):
  1. A punchy headline-style intro of the topic
  2. The actual content of the article — what happened, what was discussed
  3. ONE quick take/reaction at the end — keep it short, opinionated, but DON'T overstay
- Then move on with a quick transition: "Next up...", "Moving on...", "Also this week..."
- End with: "That's it for this week's episode of MavsBoard Weekly. For all the full articles and community discussion, head over to ${BLOG_URL}. Until next time, go Mavs."

PACING (CRITICAL):
- KEEP IT MOVING. Don't dwell on any one topic too long.
- Short sentences. Punchy delivery.
- Total length: 1200-1700 words (8-10 minutes)
- Each segment should feel like "here's what happened, here's a quick take, NEXT"

ACCURACY (CRITICAL):
- ONLY use facts from the articles below. Don't add information you "know" from elsewhere.
- Cooper Flagg is a Dallas Mavericks ROOKIE this season — he was already drafted. He plays for Dallas. Don't speculate about him being drafted.
- Kyrie Irving is currently a Dallas Maverick recovering from a torn ACL.
- The Mavs are 24-52 in a rebuild year.
- Don't make up trades, signings, or scores. Stick to what's in the articles.

VOICE:
- Casual and confident, like a buddy giving you the rundown
- Mild humor, occasional sarcasm, but not over the top
- Use "I" sparingly — only when sharing a quick take
- Refer to the audience as "Mavs sickos" or just talk to them directly

WHAT TO AVOID:
- NEVER say "fan" or "fans" or attribute things to "guys on the board"
- Don't make up details that aren't in the articles
- Don't ramble — keep each segment tight
- Don't use cliches: "let's dive in", "buckle up", "passionate and engaged", "at the end of the day"
- ABSOLUTELY NO markdown formatting. No asterisks, no bold, no headers, no bullet points. This is spoken aloud — write it as a person would say it.
- Use natural spoken transitions between segments instead of headers ("Next up..." or "Speaking of..." or "On to...")

ARTICLES TO COVER (use these as your source of truth):
${allContent}

Return ONLY the spoken script. No stage directions, no headers. Just the words the host says. Cover every article briefly. Keep it tight and accurate.`

  console.log('  Generating podcast script with Groq...')
  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: GROQ_TEXT_MODEL,
    temperature: 0.9,
    max_tokens: 6000,
  })

  let draftScript = completion.choices[0]?.message?.content?.trim() || ''

  // Initial cleanup pass — strip obvious junk
  draftScript = draftScript
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
    .replace(/\*([^*]+)\*/g, '$1')     // *italic*
    .replace(/^#+\s+/gm, '')            // # headers
    .replace(/^[-*]\s+/gm, '')          // bullet points
    .replace(/`([^`]+)`/g, '$1')        // `code`
    .replace(/—/g, ', ')                // em-dash
    .replace(/–/g, ', ')                // en-dash
    .replace(/\u2011/g, '-')            // non-breaking hyphen
    .replace(/…/g, '...')               // ellipsis
    .replace(/['']/g, "'")              // smart quotes
    .replace(/[""]/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Second pass: AI cleanup specifically for TTS readability
  console.log('  Running cleanup pass...')
  const cleanupPrompt = `Below is a draft podcast script. Your job is to clean it up so it reads PERFECTLY when spoken aloud by a TTS system.

CLEANUP TASKS:
1. Remove any remaining markdown (asterisks, headers, bullets, brackets)
2. Replace any references to "fans", "fan", "MavsBoard nation members", "guys on the board", "the community", "users on the board" — instead, the host should just state things directly as observations or use "Mavs sickos" when addressing the audience
3. Remove any forum usernames or screen names that snuck through
4. Spell out symbols and abbreviations a TTS would mispronounce: "&" -> "and", "%" -> "percent", "$38M" -> "thirty-eight million dollars", "3&D" -> "three and D", "TTS" stays as is, NBA team abbreviations stay
5. Replace stray characters: special hyphens, non-standard quotes
6. Fix awkward sentences that wouldn't flow when spoken — but DO NOT change the substance, just smooth them
7. Remove any "Quick take:" / "Bottom line:" / "Take:" labels — just have the host say it naturally as part of the flow
8. Make sure transitions between segments feel natural and varied — don't repeat the same transition phrase
9. Keep the energy and pacing intact
10. Make sure the script ends with EXACTLY this line: "That's it for this week's episode of MavsBoard Weekly. For all the full articles and community discussion, head over to ${BLOG_URL}. Until next time, go Mavs."

DO NOT:
- Add new content or facts
- Change the host's opinions
- Make it longer
- Use markdown of any kind in your output

Return ONLY the cleaned-up spoken script. No commentary, no explanations.

DRAFT SCRIPT:
${draftScript}`

  const cleanupCompletion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: cleanupPrompt }],
    model: GROQ_TEXT_MODEL,
    temperature: 0.3, // lower temp for cleanup, we want consistency
    max_tokens: 6000,
  })

  let script = cleanupCompletion.choices[0]?.message?.content?.trim() || draftScript

  // Final regex cleanup just in case
  script = script
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/—/g, ', ')
    .replace(/–/g, ', ')
    .replace(/\u2011/g, '-')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return script
}

function chunkScript(script: string, maxChars: number = CHUNK_TARGET_CHARS): string[] {
  // Split into sentences first, then group into chunks
  const sentences = script.match(/[^.!?]+[.!?]+/g) || [script]
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (current.length + trimmed.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim())
      current = trimmed
    } else {
      current += (current ? ' ' : '') + trimmed
    }
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks
}

async function generateAudioChunk(text: string, voice: string, outputPath: string): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY required')

  const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      voice,
      input: text,
      response_format: 'wav',
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Groq TTS error ${response.status}: ${text}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(outputPath, buffer)
}

async function main() {
  const args = process.argv.slice(2)
  let scriptOnly = false
  let voice = DEFAULT_VOICE

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--script-only') scriptOnly = true
    if (args[i] === '--voice' && args[i + 1]) {
      voice = args[i + 1]
      i++
    }
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) { console.error('GROQ_API_KEY required'); process.exit(1) }

  const groq = new Groq({ apiKey })

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     MavsBoard Weekly Podcast Generator                 ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // Generate the script from blog articles
  const script = await generateScript(groq)
  const wordCount = script.split(/\s+/).length
  const charCount = script.length
  const estMinutes = (charCount / 100 / 60).toFixed(1) // Orpheus does ~100 chars/sec
  console.log(`  Script: ${wordCount} words / ${charCount} chars / ~${estMinutes} min`)

  // Save the script
  await fs.mkdir(SCRIPT_DIR, { recursive: true })
  const today = new Date().toISOString().split('T')[0]
  const scriptPath = path.join(SCRIPT_DIR, `${today}.txt`)
  await fs.writeFile(scriptPath, script)
  console.log(`  ✅ Script saved: ${scriptPath}`)

  if (scriptOnly) {
    console.log('  --script-only mode, skipping audio generation')
    return
  }

  // Chunk the script for TTS
  const chunks = chunkScript(script)
  console.log(`  Chunked into ${chunks.length} segments`)

  // Generate audio for each chunk
  await fs.mkdir(PODCAST_DIR, { recursive: true })
  const tmpDir = `/tmp/podcast-${today}`
  await fs.mkdir(tmpDir, { recursive: true })

  const wavFiles: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const wavPath = path.join(tmpDir, `chunk-${String(i).padStart(3, '0')}.wav`)
    process.stdout.write(`  [${i + 1}/${chunks.length}] Generating audio... `)
    try {
      await generateAudioChunk(chunk, voice, wavPath)
      const stats = await fs.stat(wavPath)
      console.log(`✅ ${(stats.size / 1024).toFixed(0)}KB`)
      wavFiles.push(wavPath)
    } catch (err: any) {
      console.error(`❌ ${err.message}`)
      throw err
    }
  }

  // Stitch with ffmpeg, convert to MP3
  console.log('  Stitching audio with ffmpeg...')
  const concatListPath = path.join(tmpDir, 'concat.txt')
  await fs.writeFile(concatListPath, wavFiles.map(f => `file '${f}'`).join('\n'))

  const mp3Path = path.join(PODCAST_DIR, `mavsboard-weekly-${today}.mp3`)
  await execAsync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:a libmp3lame -b:a 128k "${mp3Path}"`
  )

  const mp3Stats = await fs.stat(mp3Path)
  console.log(`  ✅ Podcast saved: ${path.basename(mp3Path)} (${(mp3Stats.size / 1024 / 1024).toFixed(1)}MB)`)

  // Cleanup temp files
  for (const f of wavFiles) await fs.unlink(f).catch(() => {})
  await fs.unlink(concatListPath).catch(() => {})
  await fs.rmdir(tmpDir).catch(() => {})

  console.log()
  console.log('  Listen at: ' + mp3Path)
}

main().catch(console.error)
