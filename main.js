import { createHash } from 'node:crypto'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checkin = async (headers) => {
  const challengeResponse = await fetch('https://glados.cloud/api/user/checkin/challenge', {
    method: 'GET',
    headers,
  })
  if (!challengeResponse.ok) throw new Error(`Check-in challenge HTTP ${challengeResponse.status}`)
  const challenge = await challengeResponse.json()
  const receivedAt = Date.now()
  const nonce = challenge?.nonce
  const ttl = challenge?.ttl ?? 300000
  if (challenge?.code !== 0 || typeof nonce !== 'string' || !nonce || nonce.length > 4096 ||
      typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 2700) {
    throw new Error(`Invalid check-in challenge (code=${challenge?.code ?? 'unknown'})`)
  }

  // The site waits at least 2.5 seconds before submitting the one-time proof.
  await wait(2700)
  if (Date.now() - receivedAt >= ttl) throw new Error('Check-in challenge expired')
  const proof = createHash('sha256').update(`${nonce}.glados-observe-v1`, 'utf8').digest('hex')
  const response = await fetch('https://glados.cloud/api/user/checkin', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'glados.cloud', nonce, proof }),
  })
  if (!response.ok) throw new Error(`Check-in HTTP ${response.status}`)
  return response.json()
}

const glados = async () => {
  const notice = []
  const cookies = String(process.env.GLADOS || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const agents = String(process.env.GLADOS_UA || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!cookies.length) throw new Error('Missing GLADOS: configure the current browser Cookie')
  if (!agents.length) throw new Error('Missing GLADOS_UA: use navigator.userAgent from the browser used to log in')
  if (agents.length !== 1 && agents.length !== cookies.length) {
    throw new Error('GLADOS_UA must contain one shared UA or one UA per account')
  }
  for (const [index, cookie] of cookies.entries()) {
    try {
      const common = {
        'cookie': cookie,
        'referer': 'https://glados.cloud/console/checkin',
        'user-agent': agents.length === 1 ? agents[0] : agents[index],
      }
      const action = await checkin(common)
      const alreadyCheckedIn = action?.code === 1 &&
        action?.message === "Today's observation logged. Return tomorrow for more points."
      if (action?.code !== 0 && !alreadyCheckedIn) throw new Error(`${action?.message || 'Invalid check-in response'} (code=${action?.code}, reason=${action?.reason || 'unknown'})`)
      const status = await fetch('https://glados.cloud/api/user/status', {
        method: 'GET',
        headers: { ...common },
      }).then((r) => r.json())
      if (status?.code !== 0) throw new Error(`${status?.message || 'Invalid status response'} (code=${status?.code}, reason=${status?.reason || 'unknown'})`)
      notice.push(
        alreadyCheckedIn ? 'Checkin Already Done' : 'Checkin OK',
        `${action?.message}`,
        `Left Days ${Number(status?.data?.leftDays)}`
      )
    } catch (error) {
      process.exitCode = 1
      notice.push(
        'Checkin Error',
        `${error}`,
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }
  return notice
}

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice) return
  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue
    try {
      if (option.startsWith('console:')) {
        // Results are always printed by main, including when NOTIFY is unset.
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        })
      } else if (option.startsWith('pushplus:')) {
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('bark:')) {
        await fetch(`https://api.day.app/${option.split(':')[1]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]
        const qyweixinNotifyRebotUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyweixinToken;
        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: notice.join('<br>')
            }
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      }
    } catch (error) {
      throw error
    }
  }
}

const main = async () => {
  const notice = await glados()
  for (const line of notice) console.log(line)
  await notify(notice)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
