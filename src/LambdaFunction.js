'use strict'

const { join } = require('path')
const functionHelper = require('./functionHelper.js')
const LambdaContext = require('./LambdaContext.js')
const serverlessLog = require('./serverlessLog.js')
const {
  DEFAULT_LAMBDA_MEMORY_SIZE,
  DEFAULT_LAMBDA_TIMEOUT,
  supportedRuntimes,
} = require('./config/index.js')
const { createUniqueId, splitHandlerPathAndName } = require('./utils/index.js')

const { now } = Date

module.exports = class LambdaFunction {
  constructor(
    functionName,
    functionObj,
    provider,
    servicePath,
    serverlessPath,
    options,
  ) {
    const { name, handler } = functionObj
    const [handlerPath, handlerName] = splitHandlerPathAndName(handler)

    this._awsRequestId = null
    this._executionTimeEnded = null
    this._executionTimeStarted = null
    this._executionTimeout = null
    this._functionName = functionName
    this._handlerName = handlerName
    this._handlerPath = join(servicePath, handlerPath)
    this._lambdaName = name
    this._memorySize =
      functionObj.memorySize ||
      provider.memorySize ||
      DEFAULT_LAMBDA_MEMORY_SIZE
    this._options = options
    this._runtime = functionObj.runtime || provider.runtime
    this._serverlessPath = serverlessPath
    this._servicePath = servicePath
    this._timeout =
      (functionObj.timeout || provider.timeout || DEFAULT_LAMBDA_TIMEOUT) * 1000

    this._verifySupportedRuntime()
  }

  _startExecutionTimer() {
    this._executionTimeStarted = now()
    this._executionTimeout = this._executionTimeStarted + this._timeout * 1000
  }

  _stopExecutionTimer() {
    this._executionTimeEnded = now()
  }

  _verifySupportedRuntime() {
    // TODO what if runtime == null
    // -> fallback to node? or error out?

    if (this._runtime === 'provided') {
      this._runtime = this._options.providedRuntime

      if (!this._runtime) {
        throw new Error(
          `Runtime "provided" is not supported by "Serverless-Offline".
           Please specify the additional "providedRuntime" option.
          `,
        )
      }
    }

    // print message but keep working (don't error out or exit process)
    if (!supportedRuntimes.has(this._runtime)) {
      // this.printBlankLine(); // TODO
      console.log('')
      serverlessLog(
        `Warning: found unsupported runtime '${this._runtime}' for function '${this._functionName}'`,
      )
    }
  }

  addEvent(event) {
    this._event = event
  }

  getExecutionTimeInMillis() {
    return this._executionTimeEnded - this._executionTimeStarted
  }

  getAwsRequestId() {
    return this._awsRequestId
  }

  async runHandler() {
    this._awsRequestId = createUniqueId()

    const lambdaContext = new LambdaContext({
      awsRequestId: this._awsRequestId,
      getRemainingTimeInMillis: () => {
        const time = this._executionTimeout - now()

        // just return 0 for now if we are beyond alotted time (timeout)
        return time > 0 ? time : 0
      },
      lambdaName: this._lambdaName,
      memorySize: this._memorySize,
    })

    let callback

    const callbackCalled = new Promise((resolve, reject) => {
      callback = (err, data) => {
        if (err) {
          reject(err)
        }
        resolve(data)
      }

      lambdaContext.once('contextCalled', callback)
    })

    const context = lambdaContext.getContext()

    this._startExecutionTimer()

    // TEMP
    const funOptions = {
      functionName: this._functionName,
      handlerName: this._handlerName,
      handlerPath: this._handlerPath,
      runtime: this._runtime,
      serverlessPath: this._serverlessPath,
      servicePath: this._servicePath,
    }

    // TODO
    // debugLog(`funOptions ${stringify(funOptions, null, 2)} `)
    // this._printBlankLine()
    // debugLog(this._functionName, 'runtime', this._runtime)

    // TEMP
    const handler = functionHelper.createHandler(funOptions, this._options)

    let result

    try {
      result = handler(this._event, context, callback)
    } catch (err) {
      // this only executes when we have an exception caused by synchronous code
      // TODO logging
      console.log(err)
      throw new Error(`Uncaught error in '${this._functionName}' handler.`)
    }

    // // not a Promise, which is not supported by aws
    // if (result == null || typeof result.then !== 'function') {
    //   throw new Error(`Synchronous function execution is not supported.`);
    // }

    const callbacks = [callbackCalled]

    // Promise was returned
    if (result != null && typeof result.then === 'function') {
      callbacks.push(result)
    }

    let callbackResult

    try {
      callbackResult = await Promise.race(callbacks)
    } catch (err) {
      // TODO logging
      console.log(err)
      throw err
    }

    this._stopExecutionTimer()

    return callbackResult
  }
}
