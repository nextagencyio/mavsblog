/**
 * MavsBoard Blog Thumbnail Generator
 *
 * Generates AI art thumbnails for blog posts using Fireworks AI (Flux).
 * Uses descriptive prompts to create stylized sports illustrations
 * inspired by real players without naming them directly.
 *
 * Usage:
 *   npx tsx scripts/generate-thumbnails.ts                    # Generate for all posts missing thumbs
 *   npx tsx scripts/generate-thumbnails.ts --post kyrie       # Generate for a specific post (partial match)
 *   npx tsx scripts/generate-thumbnails.ts --test "prompt"    # Test a prompt without saving
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'
import Groq from 'groq-sdk'

dotenv.config()

const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'blog')
const ASSETS_DIR = path.join(process.cwd(), 'src', 'assets', 'thumbnails')
const FIREWORKS_API_URL = 'https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/flux-1-dev-fp8/text_to_image'

// Player descriptions for prompt building (no real names in prompts)
const PLAYER_DESCRIPTIONS: Record<string, string> = {
  'cooper flagg': 'tall young white basketball forward, short brown hair, athletic build, wearing dark navy #00285E basketball jersey number 2',
  'kyrie irving': 'athletic guard with a flat-top fade hairstyle, wearing dark navy basketball jersey number 11, with visible arm tattoos',
  'luka doncic': 'tall young white European basketball player with light brown hair, wearing gold and purple Lakers jersey',
  'dereck lively': 'very tall young Black center, slim build, wearing dark navy basketball jersey number 1',
  'anthony davis': 'tall athletic forward with a unibrow and short hair, wearing dark navy basketball jersey',
}

// Topic-to-visual-scene mapping
const TOPIC_SCENES: Record<string, string> = {
  'trade-rumors': 'basketball players in silhouette with trade arrows and team logos, dramatic lighting, digital art style',
  'draft': 'NBA draft stage with dramatic spotlights, young player walking to podium, digital illustration style',
  'tank-watch': 'basketball falling through hoop net in slow motion with lottery balls floating around, dramatic blue lighting',
  'game-recap': 'intense basketball game action at the rim, dramatic arena lighting, motion blur, sports photography style',
  'news': 'Dallas skyline at night with basketball elements, Reunion Tower, modern sports editorial illustration',
  'offseason': 'basketball court at sunset, empty arena seats, dramatic golden hour lighting, contemplative mood',
  'salary-cap': 'basketball on a desk next to contract papers and a calculator, dramatic side lighting, editorial style',
  'front-office': 'modern sports executive office overlooking a basketball court, dramatic lighting through windows',
  'nba': 'multiple basketball courts from above in a grid pattern, different team colors, aerial sports illustration',
  'weekly-digest': 'Dallas Mavericks navy blue basketball spinning on a finger with city skyline behind, dynamic sports illustration',
  'fun': 'playful cartoon-style basketball illustration with bright colors and dynamic action poses',
  'opinion': 'basketball with thought bubbles and speech bubbles around it, editorial illustration style',
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function generateImage(prompt: string, filename: string): Promise<string> {
  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) {
    throw new Error('FIREWORKS_API_KEY required in .env')
  }

  const response = await fetch(FIREWORKS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'image/jpeg',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      prompt,
      aspect_ratio: '16:9',
      num_inference_steps: 28,
      guidance_scale: 3.5,
      seed: 0,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Fireworks API error ${response.status}: ${text}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.mkdir(ASSETS_DIR, { recursive: true })
  const filePath = path.join(ASSETS_DIR, filename)
  await fs.writeFile(filePath, buffer)
  return filePath
}

async function buildPromptForPost(title: string, tags: string[], groq: Groq): Promise<string> {
  // Find relevant player descriptions
  const titleLower = title.toLowerCase()
  const playerDescs: string[] = []
  for (const [name, desc] of Object.entries(PLAYER_DESCRIPTIONS)) {
    if (titleLower.includes(name.split(' ')[1]) || titleLower.includes(name)) {
      playerDescs.push(desc)
    }
  }

  // Find relevant scene from tags
  let scene = ''
  for (const tag of tags) {
    if (TOPIC_SCENES[tag]) {
      scene = TOPIC_SCENES[tag]
      break
    }
  }

  // Use Groq to generate a refined art prompt
  const completion = await groq.chat.completions.create({
    messages: [{
      role: 'user',
      content: `Generate a short image prompt (under 80 words) for an AI image generator to create a fun cartoon thumbnail for a Dallas Mavericks basketball blog article titled "${title}".

${scene ? `Scene concept: ${scene}` : ''}

STRICT RULES:
- Bold cartoon illustration style with thick black outlines, bright vibrant saturated colors
- Dallas Mavericks color palette: navy blue, royal blue, white, orange basketball
- NO real people, NO faces, NO human figures — use silhouettes if people are needed
- Use fun metaphorical objects, props, and symbols to represent the topic
- NO text, NO words, NO letters, NO numbers on anything
- Clean composition, fun playful whimsical mood
- Think editorial cartoon / infographic art, not photorealistic

Return ONLY the image prompt, nothing else.`
    }],
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    temperature: 0.8,
    max_tokens: 200,
  })

  return completion.choices[0]?.message?.content?.trim() || `Dynamic basketball illustration in dark navy blue and royal blue, sports editorial style, dramatic arena lighting, Dallas skyline`
}

async function getPostsNeedingThumbnails(): Promise<{ slug: string; title: string; tags: string[] }[]> {
  const files = await fs.readdir(CONTENT_DIR)
  const posts: { slug: string; title: string; tags: string[] }[] = []

  for (const file of files) {
    if (!file.endsWith('.md') && !file.endsWith('.mdx')) continue
    const content = await fs.readFile(path.join(CONTENT_DIR, file), 'utf-8')

    // Check if already has a heroImage
    if (content.includes('heroImage:')) continue

    // Parse frontmatter
    const titleMatch = content.match(/title:\s*"([^"]+)"/)
    const tagsMatch = content.match(/tags:\s*\[([^\]]*)\]/)
    const title = titleMatch?.[1] || file
    const tags = tagsMatch?.[1]?.replace(/"/g, '').split(',').map(t => t.trim()) || []

    posts.push({
      slug: file.replace(/\.(md|mdx)$/, ''),
      title,
      tags,
    })
  }

  return posts
}

async function main() {
  const args = process.argv.slice(2)
  let filterPost = ''
  let testPrompt = ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--post' && args[i + 1]) {
      filterPost = args[i + 1].toLowerCase()
      i++
    } else if (args[i] === '--test' && args[i + 1]) {
      testPrompt = args[i + 1]
      i++
    }
  }

  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) {
    console.error('GROQ_API_KEY required for prompt generation')
    process.exit(1)
  }
  const groq = new Groq({ apiKey: groqKey })

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     MavsBoard Thumbnail Generator                      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // Test mode
  if (testPrompt) {
    console.log(`  Testing prompt: "${testPrompt}"`)
    const filePath = await generateImage(testPrompt, 'test-thumbnail.jpg')
    console.log(`  ✅ Saved: ${filePath}`)
    return
  }

  // Get posts needing thumbnails
  let posts = await getPostsNeedingThumbnails()

  if (filterPost) {
    posts = posts.filter(p => p.slug.toLowerCase().includes(filterPost) || p.title.toLowerCase().includes(filterPost))
  }

  if (posts.length === 0) {
    console.log('  No posts need thumbnails (all have heroImage set)')
    return
  }

  console.log(`  ${posts.length} posts need thumbnails:`)
  for (const p of posts) {
    console.log(`    - ${p.title}`)
  }
  console.log()

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]
    console.log(`  [${i + 1}/${posts.length}] ${post.title}`)

    // Generate art prompt
    console.log(`    Building prompt...`)
    const artPrompt = await buildPromptForPost(post.title, post.tags, groq)
    console.log(`    Prompt: ${artPrompt.substring(0, 100)}...`)

    // Generate image
    console.log(`    Generating image...`)
    const filename = `${post.slug}.jpg`
    try {
      const filePath = await generateImage(artPrompt, filename)
      console.log(`    ✅ Saved: ${path.basename(filePath)}`)

      // Also copy to public/og/ for OG image tags
      const ogDir = path.join(process.cwd(), 'public', 'og')
      await fs.mkdir(ogDir, { recursive: true })
      await fs.copyFile(filePath, path.join(ogDir, filename))

      // Update the markdown file to reference the thumbnail
      const mdPath = path.join(CONTENT_DIR, `${post.slug}.md`)
      let content = await fs.readFile(mdPath, 'utf-8')
      content = content.replace(
        /^(---\n(?:.*\n)*?)(---)/m,
        `$1heroImage: "../../assets/thumbnails/${filename}"\nogImage: "/og/${filename}"\n$2`
      )
      await fs.writeFile(mdPath, content)
      console.log(`    ✅ Updated frontmatter + OG image`)

    } catch (err: any) {
      console.error(`    ❌ Error: ${err.message}`)
    }

    if (i < posts.length - 1) await sleep(2000) // rate limit
  }

  console.log(`\n  ✅ Done! ${posts.length} thumbnails generated.`)
}

main().catch(console.error)
