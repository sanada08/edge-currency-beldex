/**
 * Created by paul on 7/7/17.
 */
// @flow

import { currencyInfo } from './currencyInfoXMR.js'
import type {
  EdgeTransaction,
  EdgeCurrencyEngineCallbacks,
  EdgeCurrencyEngineOptions,
  EdgeSpendInfo,
  EdgeWalletInfo,
  EdgeMetaToken,
  EdgeCurrencyInfo,
  EdgeFreshAddress,
  EdgeDataDump,
  EdgeIo, EdgeCurrencyPlugin
} from 'edge-core-js'
// import { sprintf } from 'sprintf-js'
import { bns } from 'biggystring'
import {
  DATA_STORE_FILE,
  DATA_STORE_FOLDER,
  WalletLocalData,
  type SendFundsOptions
} from './xmrTypes.js'
import { normalizeAddress, validateObject } from './utils.js'
import moneroResponseParserUtils from 'mymonero-core-js/monero_utils/mymonero_response_parser_utils.js'
import moneroSendingFundsUtils from 'mymonero-core-js/monero_utils/monero_sendingFunds_utils.js'
import { network_type as networkType } from 'mymonero-core-js/cryptonote_utils/nettype.js'

import { MoneroOpenAliasUtils } from './OpenAlias/monero_openalias_utils.js'
const MAINNET = networkType.MAINNET

const ADDRESS_POLL_MILLISECONDS = 7000
const TRANSACTIONS_POLL_MILLISECONDS = 4000
const SAVE_DATASTORE_MILLISECONDS = 10000
// const ADDRESS_QUERY_LOOKBACK_BLOCKS = '8' // ~ 2 minutes
// const ADDRESS_QUERY_LOOKBACK_BLOCKS = (4 * 60 * 24 * 7) // ~ one week

const PRIMARY_CURRENCY = currencyInfo.currencyCode

class MoneroEngine {
  walletInfo: EdgeWalletInfo
  edgeTxLibCallbacks: EdgeCurrencyEngineCallbacks
  walletLocalFolder: any
  engineOn: boolean
  loggedIn: boolean
  addressesChecked: boolean
  walletLocalData: WalletLocalData
  walletLocalDataDirty: boolean
  transactionsChangedArray: Array<EdgeTransaction>
  currencyInfo: EdgeCurrencyInfo
  allTokens: Array<EdgeMetaToken>
  keyImageCache: Object
  hostedMoneroAPIClient: Object
  currentSettings: any
  timers: any
  walletId: string
  io: EdgeIo

  constructor (currencyPlugin: EdgeCurrencyPlugin, io_: any, walletInfo: EdgeWalletInfo, hostedMoneroAPIClient: Object, opts: EdgeCurrencyEngineOptions) {
    const { walletLocalFolder, callbacks } = opts

    this.io = io_
    this.engineOn = false
    this.loggedIn = false
    this.addressesChecked = false
    this.walletLocalDataDirty = false
    this.transactionsChangedArray = []
    this.keyImageCache = {}
    this.walletInfo = walletInfo
    this.walletId = walletInfo.id ? `${walletInfo.id} - ` : ''
    this.currencyInfo = currencyInfo
    this.hostedMoneroAPIClient = hostedMoneroAPIClient
    this.allTokens = currencyInfo.metaTokens.slice(0)
    // this.customTokens = []
    this.timers = {}

    if (typeof opts.optionalSettings !== 'undefined') {
      this.currentSettings = opts.optionalSettings
    } else {
      this.currentSettings = this.currencyInfo.defaultSettings
    }

    // Hard coded for testing
    // this.walletInfo.keys.moneroKey = '389b07b3466eed587d6bdae09a3613611de9add2635432d6cd1521af7bbc3757'
    // this.walletInfo.keys.moneroAddress = '0x9fa817e5A48DD1adcA7BEc59aa6E3B1F5C4BeA9a'
    this.edgeTxLibCallbacks = callbacks
    this.walletLocalFolder = walletLocalFolder

    if (
      typeof this.walletInfo.keys.moneroAddress !== 'string' ||
      typeof this.walletInfo.keys.moneroViewKeyPrivate !== 'string' ||
      typeof this.walletInfo.keys.moneroViewKeyPublic !== 'string' ||
      typeof this.walletInfo.keys.moneroSpendKeyPublic !== 'string'
    ) {
      if (
        walletInfo.keys.moneroAddress &&
        walletInfo.keys.moneroViewKeyPrivate &&
        walletInfo.keys.moneroViewKeyPublic &&
        walletInfo.keys.moneroSpendKeyPublic
      ) {
        this.walletInfo.keys.moneroAddress = walletInfo.keys.moneroAddress
        this.walletInfo.keys.moneroViewKeyPrivate = walletInfo.keys.moneroViewKeyPrivate
        this.walletInfo.keys.moneroViewKeyPublic = walletInfo.keys.moneroViewKeyPublic
        this.walletInfo.keys.moneroSpendKeyPublic = walletInfo.keys.moneroSpendKeyPublic
      } else {
        const pubKeys = currencyPlugin.derivePublicKey(this.walletInfo)
        this.walletInfo.keys.moneroAddress = pubKeys.moneroAddress
        this.walletInfo.keys.moneroViewKeyPrivate = pubKeys.moneroViewKeyPrivate
        this.walletInfo.keys.moneroViewKeyPublic = pubKeys.moneroViewKeyPublic
        this.walletInfo.keys.moneroSpendKeyPublic = pubKeys.moneroSpendKeyPublic
      }
    }

    this.log(`Created Wallet Type ${this.walletInfo.type} for Currency Plugin ${this.currencyInfo.pluginName} `)
  }

  async fetchPost (url: string, options: Object) {
    const opts = Object.assign({}, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }, options)

    const response = await this.io.fetch(url, opts)
    if (!response.ok) {
      const cleanUrl = url.replace(global.moneroApiKey, 'private')
      throw new Error(
        `The server returned error code ${response.status} for ${cleanUrl}`
      )
    }
    return response.json()
  }

  async fetchPostMyMonero (cmd: string, params: Object = {}) {
    const body = Object.assign({}, {
      address: this.walletLocalData.moneroAddress,
      view_key: this.walletLocalData.moneroViewKeyPrivate,
      create_account: true
    }, params)

    const options = {
      body: JSON.stringify(body)
    }
    const url = `${this.currentSettings.otherSettings.mymoneroApiServers[0]}/${cmd}`
    return this.fetchPost(url, options)
  }

  updateOnAddressesChecked (numTx: number, totalTxs: number) {
    if (this.addressesChecked) {
      return
    }
    if (numTx !== totalTxs) {
      const progress = numTx / totalTxs
      this.edgeTxLibCallbacks.onAddressesChecked(progress)
    } else {
      this.addressesChecked = true
      this.edgeTxLibCallbacks.onAddressesChecked(1)
      this.walletLocalData.lastAddressQueryHeight = this.walletLocalData.blockHeight
    }
  }

  // **********************************************
  // Login to mymonero.com server
  // **********************************************
  async loginInnerLoop () {
    try {
      const result = await this.fetchPostMyMonero('login')
      if (result.hasOwnProperty('new_address') && !this.loggedIn) {
        this.loggedIn = true
        clearTimeout(this.timers.loginInnerLoop)
        delete this.timers.loginInnerLoop
        this.addToLoop('checkAddressInnerLoop', ADDRESS_POLL_MILLISECONDS)
        this.addToLoop('checkTransactionsInnerLoop', TRANSACTIONS_POLL_MILLISECONDS)
        this.addToLoop('saveWalletLoop', SAVE_DATASTORE_MILLISECONDS)
      }
    } catch (e) {
      console.log('Error logging into mymonero', e)
    }
  }

  // ***************************************************
  // Check address for updated block height and balance
  // ***************************************************
  async checkAddressInnerLoop () {
    try {
      const result = await this.fetchPostMyMonero('get_address_info')
      const valid = validateObject(result, {
        'type': 'object',
        'properties': {
          'locked_funds': {'type': 'string'},
          'total_received': {'type': 'string'},
          'total_sent': {'type': 'string'},
          'scanned_height': {'type': 'number'},
          'scanned_block_height': {'type': 'number'},
          'start_height': {'type': 'number'},
          'transaction_height': {'type': 'number'},
          'blockchain_height': {'type': 'number'}
        }
      })

      if (valid) {
        const parsedAddrInfo = moneroResponseParserUtils.Parsed_AddressInfo__sync(
          this.keyImageCache,
          result,
          this.walletLocalData.moneroAddress,
          this.walletLocalData.moneroViewKeyPrivate,
          this.walletLocalData.moneroSpendKeyPublic,
          this.walletInfo.keys.moneroSpendKeyPrivate
        )
        if (this.walletLocalData.blockHeight !== parsedAddrInfo.blockchain_height) {
          this.walletLocalData.blockHeight = parsedAddrInfo.blockchain_height // Convert to decimal
          this.walletLocalDataDirty = true
          this.edgeTxLibCallbacks.onBlockHeightChanged(this.walletLocalData.blockHeight)
        }

        const nativeBalance = bns.sub(parsedAddrInfo.total_received_String, parsedAddrInfo.total_sent_String)

        if (this.walletLocalData.totalBalances.XMR !== nativeBalance) {
          this.walletLocalData.totalBalances.XMR = nativeBalance
          this.edgeTxLibCallbacks.onBalanceChanged('XMR', nativeBalance)
        }
      }
    } catch (e) {
      this.log('Error fetching address info: ' + this.walletLocalData.moneroAddress)
    }
  }

  processMoneroTransaction (tx: Object) {
    const ourReceiveAddresses: Array<string> = []

    // const nativeNetworkFee:string = bns.mul(tx.gasPrice, tx.gasUsed)
    const nativeNetworkFee: string = '0' // Can't know the fee right now. Limitation of monero

    const netNativeAmount: string = bns.sub(tx.total_received, tx.total_sent)
    if (netNativeAmount.slice(0, 1) !== '-') {
      ourReceiveAddresses.push(this.walletLocalData.moneroAddress.toLowerCase())
    }

    let blockHeight = tx.height
    if (tx.mempool) {
      blockHeight = 0
    }

    const date = Date.parse(tx.timestamp) / 1000

    const edgeTransaction: EdgeTransaction = {
      txid: tx.hash,
      date,
      currencyCode: 'XMR',
      blockHeight,
      nativeAmount: netNativeAmount,
      networkFee: nativeNetworkFee,
      ourReceiveAddresses,
      signedTx: 'no_signature',
      otherParams: {}
    }

    const idx = this.findTransaction(PRIMARY_CURRENCY, tx.hash)
    if (idx === -1) {
      this.log(`New transaction: ${tx.hash}`)

      // New transaction not in database
      this.addTransaction(PRIMARY_CURRENCY, edgeTransaction)

      this.edgeTxLibCallbacks.onTransactionsChanged(
        this.transactionsChangedArray
      )
      this.transactionsChangedArray = []
    } else {
      // Already have this tx in the database. See if anything changed
      const transactionsArray = this.walletLocalData.transactionsObj[ PRIMARY_CURRENCY ]
      const edgeTx = transactionsArray[ idx ]

      if (edgeTransaction.blockHeight) {
        // Only update old transactions if the incoming tx is confirmed
        // Unconfirmed txs will sometimes have incorrect values
        if (
          edgeTx.blockHeight !== edgeTransaction.blockHeight ||
          edgeTx.networkFee !== edgeTransaction.networkFee ||
          edgeTx.nativeAmount !== edgeTransaction.nativeAmount
        ) {
          this.log(`Update transaction: ${tx.hash} height:${tx.blockNumber}`)
          this.updateTransaction(PRIMARY_CURRENCY, edgeTransaction, idx)
          this.edgeTxLibCallbacks.onTransactionsChanged(
            this.transactionsChangedArray
          )
          this.transactionsChangedArray = []
        } else {
          // this.log(sprintf('Old transaction. No Update: %s', tx.hash))
        }
      }
    }
  }

  async checkTransactionsInnerLoop () {
    let checkAddressSuccess = true

    // TODO: support partial query by block height once API supports it
    // const endBlock:number = 999999999
    // let startBlock:number = 0
    // if (this.walletLocalData.lastAddressQueryHeight > ADDRESS_QUERY_LOOKBACK_BLOCKS) {
    //   // Only query for transactions as far back as ADDRESS_QUERY_LOOKBACK_BLOCKS from the last time we queried transactions
    //   startBlock = this.walletLocalData.lastAddressQueryHeight - ADDRESS_QUERY_LOOKBACK_BLOCKS
    // }

    try {
      const result = await this.fetchPostMyMonero('get_address_txs')
      const valid = validateObject(result, {
        'type': 'object',
        'properties': {
          'total_received': {'type': 'string'},
          'scanned_height': {'type': 'number'},
          'scanned_block_height': {'type': 'number'},
          'start_height': {'type': 'number'},
          'transaction_height': {'type': 'number'},
          'transactions': {
            'type': 'array',
            'items': {
              'type': 'object',
              'properties': {
                'hash': {'type': 'string'},
                'timestamp': {'type': 'string'},
                'total_received': {'type': 'string'},
                'total_sent': {'type': 'string'},
                'unlock_time': {'type': 'number'},
                'height': {'type': 'number'},
                'coinbase': {'type': 'boolean'},
                'mempool': {'type': 'boolean'}
              }
            }
          }
        }
      })

      if (valid) {
        const parsedTxs = moneroResponseParserUtils.Parsed_AddressTransactions__sync(
          this.keyImageCache,
          result,
          this.walletLocalData.moneroAddress,
          this.walletLocalData.moneroViewKeyPrivate,
          this.walletLocalData.moneroSpendKeyPublic,
          this.walletInfo.keys.moneroSpendKeyPrivate
        )

        const transactions = parsedTxs.serialized_transactions
        this.log('Fetched transactions count: ' + transactions.length)

        // Get transactions
        // Iterate over transactions in address
        for (let i = 0; i < transactions.length; i++) {
          const tx = transactions[i]
          this.processMoneroTransaction(tx)
          if (i % 10 === 0) {
            this.updateOnAddressesChecked(i, transactions.length)
          }
        }
        this.updateOnAddressesChecked(transactions.length, transactions.length)
      } else {
        checkAddressSuccess = false
      }
    } catch (e) {
      this.log(e)
      checkAddressSuccess = false
    }
    return checkAddressSuccess
  }

  findTransaction (currencyCode: string, txid: string) {
    if (typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined') {
      return -1
    }

    const currency = this.walletLocalData.transactionsObj[currencyCode]
    return currency.findIndex(element => {
      return normalizeAddress(element.txid) === normalizeAddress(txid)
    })
  }

  sortTxByDate (a: EdgeTransaction, b: EdgeTransaction) {
    return b.date - a.date
  }

  addTransaction (currencyCode: string, edgeTransaction: EdgeTransaction) {
    // Add or update tx in transactionsObj
    const idx = this.findTransaction(currencyCode, edgeTransaction.txid)

    if (idx === -1) {
      this.log('addTransaction: adding and sorting:' + edgeTransaction.txid)
      if (typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined') {
        this.walletLocalData.transactionsObj[currencyCode] = []
      }
      this.walletLocalData.transactionsObj[currencyCode].push(edgeTransaction)

      // Sort
      this.walletLocalData.transactionsObj[currencyCode].sort(this.sortTxByDate)
      this.walletLocalDataDirty = true
      this.transactionsChangedArray.push(edgeTransaction)
    } else {
      this.updateTransaction(currencyCode, edgeTransaction, idx)
    }
  }

  updateTransaction (currencyCode: string, edgeTransaction: EdgeTransaction, idx: number) {
    // Update the transaction
    this.walletLocalData.transactionsObj[currencyCode][idx] = edgeTransaction
    this.walletLocalDataDirty = true
    this.transactionsChangedArray.push(edgeTransaction)
    this.log('updateTransaction:' + edgeTransaction.txid)
  }

  // *************************************
  // Save the wallet data store
  // *************************************
  async saveWalletLoop () {
    if (this.walletLocalDataDirty) {
      try {
        this.log('walletLocalDataDirty. Saving...')
        const walletJson = JSON.stringify(this.walletLocalData)
        await this.walletLocalFolder
          .folder(DATA_STORE_FOLDER)
          .file(DATA_STORE_FILE)
          .setText(walletJson)
        this.walletLocalDataDirty = false
      } catch (err) {
        this.log(err)
      }
    }
  }

  doInitialCallbacks () {
    for (const currencyCode of this.walletLocalData.enabledTokens) {
      try {
        this.edgeTxLibCallbacks.onTransactionsChanged(
          this.walletLocalData.transactionsObj[currencyCode]
        )
        this.edgeTxLibCallbacks.onBalanceChanged(currencyCode, this.walletLocalData.totalBalances[currencyCode])
      } catch (e) {
        this.log('Error for currencyCode', currencyCode, e)
      }
    }
  }

  async addToLoop (func: string, timer: number) {
    try {
      // $FlowFixMe
      await this[func]()
    } catch (e) {
      this.log('Error in Loop:', func, e)
    }
    if (this.engineOn) {
      this.timers[func] = setTimeout(() => {
        if (this.engineOn) {
          this.addToLoop(func, timer)
        }
      }, timer)
    }
    return true
  }

  log (...text: Array<any>) {
    text[0] = `${this.walletId}${text[0]}`
    console.log(...text)
  }

  async SendFundsWithOptionsAsync (options: SendFundsOptions) {
    return new Promise((resolve, reject) => {
      moneroSendingFundsUtils.SendFundsWithOptions(
        options,
        (code) => {
          console.log(`SendFundsWithOptionsAsync code:${code}`)
        },
        (result) => {
          console.log(`SendFundsWithOptionsAsync result:${JSON.stringify(result)}`)
          resolve(result)
        },
        (err) => {
          console.log(`SendFundsWithOptionsAsync error:${err}`)
          reject(err)
        }
      )
    })
  }
  //
  // async SubmitSerializedSignedTransactionAsync (signedTx: string, destinationAddress: string, moneroViewKeyPrivate: string) {
  //   // Broadcast the transaction
  //   return new Promise((resolve, reject) => {
  //     this.hostedMoneroAPIClient.SubmitSerializedSignedTransaction(
  //       destinationAddress,
  //       moneroViewKeyPrivate,
  //       signedTx,
  //       (err) => {
  //         if (err) {
  //           console.log('Something unexpected occurred when submitting your transaction:', err)
  //           reject(err)
  //         }
  //         console.log('*** Success Sending Transaction *** ')
  //         resolve(true)
  //       }
  //     )
  //   })
  // }
  // *************************************
  // Public methods
  // *************************************

  updateSettings (settings: any) {
    this.currentSettings = settings
  }

  async startEngine () {
    this.engineOn = true
    this.doInitialCallbacks()
    this.addToLoop('loginInnerLoop', ADDRESS_POLL_MILLISECONDS)
  }

  async killEngine () {
    // Set status flag to false
    this.engineOn = false
    this.loggedIn = false
    // Clear Inner loops timers
    for (const timer in this.timers) {
      clearTimeout(this.timers[timer])
    }
    this.timers = {}
  }

  async resyncBlockchain (): Promise<void> {
    await this.killEngine()
    const temp = JSON.stringify({
      enabledTokens: this.walletLocalData.enabledTokens,
      // networkFees: this.walletLocalData.networkFees,
      moneroAddress: this.walletLocalData.moneroAddress,
      moneroViewKeyPrivate: this.walletLocalData.moneroViewKeyPrivate
    })
    this.walletLocalData = new WalletLocalData(temp)
    this.walletLocalDataDirty = true
    await this.saveWalletLoop()
    await this.startEngine()
  }

  // synchronous
  getBlockHeight (): number {
    return parseInt(this.walletLocalData.blockHeight)
  }

  enableTokensSync (tokens: Array<string>) {
    for (const token of tokens) {
      if (this.walletLocalData.enabledTokens.indexOf(token) === -1) {
        this.walletLocalData.enabledTokens.push(token)
      }
    }
  }

  // asynchronous
  async enableTokens (tokens: Array<string>) {}

  // asynchronous
  async disableTokens (tokens: Array<string>) {}

  async getEnabledTokens (): Promise<Array<string>> {
    return []
  }

  async addCustomToken (tokenObj: any) {}

  // synchronous
  getTokenStatus (token: string) {
    return false
  }

  // synchronous
  getBalance (options: any): string {
    let currencyCode = PRIMARY_CURRENCY

    if (typeof options !== 'undefined') {
      const valid = validateObject(options, {
        'type': 'object',
        'properties': {
          'currencyCode': {'type': 'string'}
        }
      })

      if (valid) {
        currencyCode = options.currencyCode
      }
    }

    if (typeof this.walletLocalData.totalBalances[currencyCode] === 'undefined') {
      return '0'
    } else {
      const nativeBalance = this.walletLocalData.totalBalances[currencyCode]
      return nativeBalance
    }
  }

  // synchronous
  getNumTransactions (options: any): number {
    let currencyCode = PRIMARY_CURRENCY

    const valid = validateObject(options, {
      'type': 'object',
      'properties': {
        'currencyCode': {'type': 'string'}
      }
    })

    if (valid) {
      currencyCode = options.currencyCode
    }

    if (typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined') {
      return 0
    } else {
      return this.walletLocalData.transactionsObj[currencyCode].length
    }
  }

  // asynchronous
  async getTransactions (options: any) {
    let currencyCode:string = PRIMARY_CURRENCY

    const valid:boolean = validateObject(options, {
      'type': 'object',
      'properties': {
        'currencyCode': {'type': 'string'}
      }
    })

    if (valid) {
      currencyCode = options.currencyCode
    }

    if (typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined') {
      return []
    }

    let startIndex:number = 0
    let numEntries:number = 0
    if (options === null) {
      return this.walletLocalData.transactionsObj[currencyCode].slice(0)
    }
    if (options.startIndex !== null && options.startIndex > 0) {
      startIndex = options.startIndex
      if (
        startIndex >=
        this.walletLocalData.transactionsObj[currencyCode].length
      ) {
        startIndex =
          this.walletLocalData.transactionsObj[currencyCode].length - 1
      }
    }
    if (options.numEntries !== null && options.numEntries > 0) {
      numEntries = options.numEntries
      if (
        numEntries + startIndex >
        this.walletLocalData.transactionsObj[currencyCode].length
      ) {
        // Don't read past the end of the transactionsObj
        numEntries =
          this.walletLocalData.transactionsObj[currencyCode].length -
          startIndex
      }
    }

    // Copy the appropriate entries from the arrayTransactions
    let returnArray = []

    if (numEntries) {
      returnArray = this.walletLocalData.transactionsObj[currencyCode].slice(
        startIndex,
        numEntries + startIndex
      )
    } else {
      returnArray = this.walletLocalData.transactionsObj[currencyCode].slice(
        startIndex
      )
    }
    return returnArray
  }

  // synchronous
  getFreshAddress (options: any): EdgeFreshAddress {
    return { publicAddress: this.walletLocalData.moneroAddress }
  }

  // synchronous
  addGapLimitAddresses (addresses: Array<string>, options: any) {
  }

  // synchronous
  isAddressUsed (address: string, options: any) {
    return false
  }

  // synchronous
  async makeSpend (edgeSpendInfo: EdgeSpendInfo) {
    // Validate the spendInfo
    const valid = validateObject(edgeSpendInfo, {
      'type': 'object',
      'properties': {
        'currencyCode': { 'type': 'string' },
        'networkFeeOption': { 'type': 'string' },
        'spendTargets': {
          'type': 'array',
          'items': {
            'type': 'object',
            'properties': {
              'currencyCode': { 'type': 'string' },
              'publicAddress': { 'type': 'string' },
              'nativeAmount': { 'type': 'string' },
              'destMetadata': { 'type': 'object' },
              'destWallet': { 'type': 'object' }
            },
            'required': [
              'publicAddress'
            ]
          }
        }
      },
      'required': [ 'spendTargets' ]
    })

    if (!valid) {
      throw (new Error('Error: invalid ABCSpendInfo'))
    }

    // Monero can only have one output
    if (edgeSpendInfo.spendTargets.length !== 1) {
      throw (new Error('Error: only one output allowed'))
    }

    const currencyCode: string = 'XMR'
    // }
    edgeSpendInfo.currencyCode = currencyCode

    let publicAddress = ''
    if (typeof edgeSpendInfo.spendTargets[0].publicAddress === 'string') {
      publicAddress = edgeSpendInfo.spendTargets[0].publicAddress
    } else {
      throw new Error('No valid spendTarget')
    }

    let nativeAmount = '0'
    if (typeof edgeSpendInfo.spendTargets[0].nativeAmount === 'string') {
      nativeAmount = edgeSpendInfo.spendTargets[0].nativeAmount
    } else {
      throw (new Error('Error: no amount specified'))
    }

    if (bns.eq(nativeAmount, '0')) {
      throw (new Error('ErrorNoAmountSpecified'))
    }

    const InsufficientFundsError = new Error('Insufficient funds')
    InsufficientFundsError.name = 'ErrorInsufficientFunds'

    if (bns.gte(nativeAmount, this.walletLocalData.totalBalances.XMR)) {
      throw InsufficientFundsError
    }

    let result
    let options: SendFundsOptions
    try {
      const amountFloatString: string = bns.div(nativeAmount, '1000000000000', 8)
      // Todo: Yikes. Why does mymonero-core-js take a float, not a string? -paulvp
      const amountFloat = parseFloat(amountFloatString)
      options = {
        isRingCT: true,
        target_address: publicAddress, // currency-ready wallet address, but not an OA address (resolve before calling)
        nettype: MAINNET,
        amount: amountFloat, // number
        wallet__keyImage_cache: this.keyImageCache,
        wallet__public_address: this.walletLocalData.moneroAddress,
        wallet__private_keys: { view: this.walletLocalData.moneroViewKeyPrivate, spend: this.walletInfo.keys.moneroSpendKeyPrivate },
        wallet__public_keys: { view: this.walletLocalData.moneroViewKeyPublic, spend: this.walletInfo.keys.moneroSpendKeyPublic },
        hostedMoneroAPIClient: this.hostedMoneroAPIClient,
        monero_openalias_utils: MoneroOpenAliasUtils,
        payment_id: null,
        mixin: 6,
        simple_priority: 1,
        doNotBroadcast: true
      }
      result = await this.SendFundsWithOptionsAsync(options)
    } catch (e) {
      console.log(`makeSpend error: ${e}`)
      throw e
    }

    const nativeNetworkFee = result.tx_fee

    const date = Date.now() / 1000
    nativeAmount = '-' + nativeAmount

    const edgeTransaction: EdgeTransaction = {
      txid: result.tx_hash,
      date,
      currencyCode, // currencyCode
      blockHeight: 0, // blockHeight
      nativeAmount, // nativeAmount
      networkFee: nativeNetworkFee,
      ourReceiveAddresses: [], // ourReceiveAddresses
      signedTx: '', // signedTx
      otherParams: {
        options
      }
    }

    return edgeTransaction
  }

  // asynchronous
  async signTx (edgeTransaction: EdgeTransaction): Promise<EdgeTransaction> {
    // Monero transactions are signed at broadcast
    if (edgeTransaction.otherParams.options) {
      return edgeTransaction
    } else {
      throw new Error('Invalid EdgeTransaction. No otherParams.options')
    }
  }

  // asynchronous
  async broadcastTx (edgeTransaction: EdgeTransaction): Promise<EdgeTransaction> {
    try {
      edgeTransaction.otherParams.options.doNotBroadcast = false
      const result = await this.SendFundsWithOptionsAsync(edgeTransaction.otherParams.options)
      edgeTransaction.txid = result.tx_hash
      edgeTransaction.networkFee = result.tx_fee
      console.log(`broadcastTx success txid: ${edgeTransaction.txid}`)
      return edgeTransaction
    } catch (e) {
      throw e
    }
  }

  // asynchronous
  async saveTx (edgeTransaction: EdgeTransaction) {
    this.addTransaction(edgeTransaction.currencyCode, edgeTransaction)

    this.edgeTxLibCallbacks.onTransactionsChanged([edgeTransaction])
  }

  getDisplayPrivateSeed () {
    if (this.walletInfo.keys && this.walletInfo.keys.moneroKey) {
      return this.walletInfo.keys.moneroKey
    }
    return ''
  }

  getDisplayPublicSeed () {
    if (this.walletInfo.keys && this.walletInfo.keys.moneroAddress) {
      return this.walletInfo.keys.moneroAddress
    }
    return ''
  }

  dumpData (): EdgeDataDump {
    const dataDump: EdgeDataDump = {
      walletId: this.walletId.split(' - ')[0],
      walletType: this.walletInfo.type,
      pluginType: this.currencyInfo.pluginName,
      data: {
        walletLocalData: this.walletLocalData
      }
    }
    return dataDump
  }
}

export { MoneroEngine }
