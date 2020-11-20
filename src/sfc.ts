import hash from 'hash-sum'
import path from 'path'
import qs from 'querystring'
import {
  compileScript,
  parse,
  SFCBlock,
  SFCDescriptor,
  SFCTemplateCompileOptions,
} from '@vue/compiler-sfc'
import { Options } from '.'
import { getTemplateCompilerOptions } from './template'
import { setDescriptor } from './utils/descriptorCache'
import { TransformPluginContext } from 'rollup'
import { createRollupError } from './utils/error'

export function transformSFCEntry(
  code: string,
  resourcePath: string,
  options: Options,
  sourceRoot: string,
  isProduction: boolean,
  isServer: boolean,
  filterCustomBlock: (type: string) => boolean,
  pluginContext: TransformPluginContext
) {
  const { descriptor, errors } = parse(code, {
    sourceMap: true,
    filename: resourcePath,
    sourceRoot,
  })
  setDescriptor(resourcePath, descriptor)

  if (errors.length) {
    errors.forEach((error) =>
      pluginContext.error(createRollupError(resourcePath, error))
    )
    return null
  }

  const shortFilePath = path
    .relative(sourceRoot, resourcePath)
    .replace(/^(\.\.[\/\\])+/, '')
    .replace(/\\/g, '/')
  const scopeId = hash(
    isProduction ? shortFilePath + '\n' + code : shortFilePath
  )
  // feature information
  const hasScoped = descriptor.styles.some((s) => s.scoped)

  const hasTemplateImport =
    descriptor.template &&
    // script setup compiles template inline, do not import again
    (isServer || !descriptor.scriptSetup)

  const templateImport = hasTemplateImport
    ? genTemplateCode(descriptor, resourcePath, scopeId, isServer)
    : ''

  const renderReplace = hasTemplateImport
    ? isServer
      ? `script.ssrRender = ssrRender`
      : `script.render = render`
    : ''

  const scriptImport = genScriptCode(
    descriptor,
    resourcePath,
    scopeId,
    isProduction,
    isServer,
    getTemplateCompilerOptions(options, descriptor, scopeId)
  )
  const stylesCode = genStyleCode(
    descriptor,
    resourcePath,
    scopeId,
    options.preprocessStyles
  )
  const customBlocksCode = getCustomBlock(
    descriptor,
    resourcePath,
    filterCustomBlock
  )
  const output = [
    scriptImport,
    templateImport,
    stylesCode,
    customBlocksCode,
    renderReplace,
  ]
  if (hasScoped) {
    output.push(`script.__scopeId = ${JSON.stringify(`data-v-${scopeId}`)}`)
  }
  if (!isProduction) {
    output.push(`script.__file = ${JSON.stringify(shortFilePath)}`)
  } else if (options.exposeFilename) {
    output.push(
      `script.__file = ${JSON.stringify(path.basename(shortFilePath))}`
    )
  }
  output.push('export default script')
  return {
    code: output.join('\n'),
    map: {
      mappings: '',
    },
  }
}

function genTemplateCode(
  descriptor: SFCDescriptor,
  resourcePath: string,
  id: string,
  isServer: boolean
) {
  const renderFnName = isServer ? 'ssrRender' : 'render'
  let templateImport = `const ${renderFnName} = () => {}`
  let templateRequest
  if (descriptor.template) {
    const src = descriptor.template.src || resourcePath
    const idQuery = `&id=${id}`
    const srcQuery = descriptor.template.src ? `&src` : ``
    const attrsQuery = attrsToQuery(descriptor.template.attrs, 'js', true)
    const query = `?vue&type=template${idQuery}${srcQuery}${attrsQuery}`
    templateRequest = JSON.stringify(src + query)
    templateImport = `import { ${renderFnName} } from ${templateRequest}`
  }

  return templateImport
}

function genScriptCode(
  descriptor: SFCDescriptor,
  resourcePath: string,
  id: string,
  isProd: boolean,
  isServer: boolean,
  templateOptions?: Partial<SFCTemplateCompileOptions>
) {
  let scriptImport = `const script = {}`
  if (descriptor.script || descriptor.scriptSetup) {
    if (compileScript) {
      descriptor.scriptCompiled = compileScript(descriptor, {
        id,
        isProd,
        inlineTemplate: !isServer,
        templateOptions,
      })
    }
    const script = descriptor.scriptCompiled || descriptor.script
    if (script) {
      const src = script.src || resourcePath
      const attrsQuery = attrsToQuery(script.attrs, 'js')
      const srcQuery = script.src ? `&src` : ``
      const query = `?vue&type=script${srcQuery}${attrsQuery}`
      const scriptRequest = JSON.stringify(src + query)
      scriptImport =
        `import script from ${scriptRequest}\n` +
        `export * from ${scriptRequest}` // support named exports
    }
  }
  return scriptImport
}

function genStyleCode(
  descriptor: SFCDescriptor,
  resourcePath: string,
  id: string,
  preprocessStyles?: boolean
) {
  let stylesCode = ``
  let hasCSSModules = false
  if (descriptor.styles.length) {
    descriptor.styles.forEach((style, i) => {
      const src = style.src || resourcePath
      // do not include module in default query, since we use it to indicate
      // that the module needs to export the modules json
      const attrsQuery = attrsToQuery(style.attrs, 'css', preprocessStyles)
      const attrsQueryWithoutModule = attrsQuery.replace(
        /&module(=true|=[^&]+)?/,
        ''
      )
      // make sure to only pass id when necessary so that we don't inject
      // duplicate tags when multiple components import the same css file
      const idQuery = `&id=${id}`
      const srcQuery = style.src ? `&src` : ``
      const query = `?vue&type=style&index=${i}${srcQuery}${idQuery}`
      const styleRequest = src + query + attrsQuery
      const styleRequestWithoutModule = src + query + attrsQueryWithoutModule
      if (style.module) {
        if (!hasCSSModules) {
          stylesCode += `\nconst cssModules = script.__cssModules = {}`
          hasCSSModules = true
        }
        stylesCode += genCSSModulesCode(
          id,
          i,
          styleRequest,
          styleRequestWithoutModule,
          style.module
        )
      } else {
        stylesCode += `\nimport ${JSON.stringify(styleRequest)}`
      }
      // TODO SSR critical CSS collection
    })
  }
  return stylesCode
}

function getCustomBlock(
  descriptor: SFCDescriptor,
  resourcePath: string,
  filter: (type: string) => boolean
) {
  let code = ''

  descriptor.customBlocks.forEach((block, index) => {
    if (filter(block.type)) {
      const src = block.src || resourcePath
      const attrsQuery = attrsToQuery(block.attrs, block.type)
      const srcQuery = block.src ? `&src` : ``
      const query = `?vue&type=${block.type}&index=${index}${srcQuery}${attrsQuery}`
      const request = JSON.stringify(src + query)
      code += `import block${index} from ${request}\n`
      code += `if (typeof block${index} === 'function') block${index}(script)\n`
    }
  })

  return code
}

function genCSSModulesCode(
  // @ts-ignore
  id: string,
  index: number,
  request: string,
  requestWithoutModule: string,
  moduleName: string | boolean
): string {
  const styleVar = `style${index}`
  let code =
    // first import the CSS for extraction
    `\nimport ${JSON.stringify(requestWithoutModule)}` +
    // then import the json file to expose to component...
    `\nimport ${styleVar} from ${JSON.stringify(request + '.js')}`

  // inject variable
  const name = typeof moduleName === 'string' ? moduleName : '$style'
  code += `\ncssModules["${name}"] = ${styleVar}`
  return code
}

// these are built-in query parameters so should be ignored
// if the user happen to add them as attrs
const ignoreList = ['id', 'index', 'src', 'type', 'lang']

function attrsToQuery(
  attrs: SFCBlock['attrs'],
  langFallback?: string,
  forceLangFallback = false
): string {
  let query = ``
  for (const name in attrs) {
    const value = attrs[name]
    if (!ignoreList.includes(name)) {
      query += `&${qs.escape(name)}${
        value ? `=${qs.escape(String(value))}` : ``
      }`
    }
  }
  if (langFallback || attrs.lang) {
    query +=
      `lang` in attrs
        ? forceLangFallback
          ? `&lang.${langFallback}`
          : `&lang.${attrs.lang}`
        : `&lang.${langFallback}`
  }
  return query
}
