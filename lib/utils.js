const fs = require('fs')
const path = require('path')
const glob = require('glob')
const chalk = require('chalk')
const {exec} = require('shelljs')

const cleanupHcl = (hcl) => {
  const objects = {}
  hcl.map(object => {
    const title = Object.keys(object)[0]
    const values = {}
    object[title].map((value) => {
      const key = Object.keys(value)[0]
      let val = value[key]
      if (typeof val === 'object' && 'hint' in val && val.hint === 'block') {
        val = val.value
        const env = {}
        val.map(obj => {
          const key = Object.keys(obj)[0]
          env[key] = obj[key]
        })
        val = env
      }
      values[key] = val
    })
    objects[title] = values
  })

  return objects
}

const err = (message) => {
  console.log('\n' + chalk.red(message) + '\n')

  process.exit(1)
}

const buildDependencies = (startAction, actions) => {
  let output = [startAction]

  if (!(startAction in actions)) {
    err(`Action "${startAction}" referenced but not found`)
  }

  const action = actions[startAction]
  if (action && 'needs' in action && action.needs) {
    if (typeof action.needs === 'string') {
      action.needs = [action.needs]
    } else if (typeof action.needs !== 'object') {
      err(`Action "${startAction}" has invalid value for key 'needs'`)
    }
    action.needs.forEach(item => {
      output = output.concat(buildDependencies(item, actions).reverse())
    })
  }

  return output.reverse()
}

const resolveRunner = (uses) => {
  // TODO: add support for a local Dockerfile path
  // https://developer.github.com/actions/creating-workflows/workflow-configuration-options/#using-a-dockerfile-image-in-an-action

  let [url, version] = uses.split('@', 2)
  version = version || 'master'

  let [user, repo, subdir] = url.split('/', 3)
  subdir = subdir || ''

  let baseName = `${user}-${repo}-${subdir.replace(/\//g, '-')}`.replace(/-+$/, '')
  let cacheFile = `/tmp/gha.${baseName}-${version}`
  let dockerFile = `${cacheFile}/*/${subdir}/Dockerfile`

  if (!glob.sync(dockerFile).length) {
    exec(`curl -o ${cacheFile}.tgz --fail --silent --show-error --location https://api.github.com/repos/${user}/${repo}/tarball/${version}`)
    exec(`mkdir -p ${cacheFile}`)
    exec(`tar xf ${cacheFile}.tgz -C ${cacheFile}/`)
    exec(`rm ${cacheFile}.tgz`)
  }

  if (!glob.sync(dockerFile).length) {
    err(`Could not find Dockerfile: ${dockerFile}`)
  }

  dockerFile = glob.sync(dockerFile)[0]
  let baseDir = path.dirname(dockerFile)
  let imageName = path.basename(baseDir)

  exec(`if [[ "$(docker images -q ${imageName} 2> /dev/null)" == "" ]]; then
    docker build ${baseDir} -f ${dockerFile} -t ${imageName};
  fi`)

  return imageName
}

const defaultEnv = (action, event) => {
  return {
    GITHUB_ACTOR: 'octocat',
    HOME: '/github/home',
    GITHUB_REPOSITORY: 'github/example',
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: '/github/workflow/event.json',
    GITHUB_WORKSPACE: '/github/workspace',
    GITHUB_SHA: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    GITHUB_TOKEN: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    GITHUB_REF: 'refs/heads/master'
  }
}

const runAction = (actionTitle, actions, event) => {
  console.log(chalk.bold(chalk.blue(`===> ${actionTitle}`)))

  const action = actions[actionTitle]
  if (!('uses' in action) || !action.uses || typeof action.uses !== 'string') {
    err(`Invalid 'uses' key for this action`)
  }

  const uses = action.uses
  const imageName = resolveRunner(uses)
  let args = []

  if ('runs' in action && action.runs) {
    args.push(`--entrypoint "${action.runs.replace(/"/g, '\"')}"`)
  }

  action.env = Object.assign(defaultEnv(action, event), 'env' in action && action.env ? action.env : {})
  for (const title in action.env) {
    if (!action.env.hasOwnProperty(title)) {
      continue
    }
    args.push(`--env ${title}="${action.env[title].replace(/"/g, '\"')}"`)
  }

  let after = ''
  if ('args' in action && action.args) {
    if (typeof action.args === 'object') {
      action.args = action.args.join(' ')
    }
    after = action.args
  }

  const cmd = `docker run --rm -t -v \`pwd\`:/github/workspace -w /github/workspace ${args.join(' ')} ${imageName} ${after}`
  const res = exec(cmd)

  if (res.code === 0) {
    console.log(chalk.green('(success)'))
  } else if (res.code === 78) {
    console.log(chalk.magenta('(neutral, skipping other steps)'))
    process.exit(0)
  } else {
    err(`Command failed with error code ${res.code}`)
  }

  console.log('\n')
}

const checkDocker = () => {
  if (exec('docker -v', {async: false, silent: true}).code !== 0) {
    err('Could not find docker locally')
  }
}

module.exports = {
  cleanupHcl,
  buildDependencies,
  runAction,
  checkDocker
}