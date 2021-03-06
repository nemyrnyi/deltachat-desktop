const DeltaChat = require('deltachat-node')
const C = require('deltachat-node/constants')
const EventEmitter = require('events').EventEmitter
const path = require('path')
const log = require('../logger').getLogger('main/deltachat')

const PAGE_SIZE = 20

/**
 * The Controller is the container for a deltachat instance
 */
class DeltaChatController extends EventEmitter {
  /**
   * Created and owned by ipc on the backend
   */
  constructor (cwd, saved) {
    super()
    this.cwd = cwd
    this._resetState()
    if (!saved) throw new Error('Saved settings are a required argument to DeltaChatController')
    this._saved = saved
  }

  // Save settings for RC
  updateSettings (saved) {
    this._saved = saved
  }

  getPath (addr) {
    return path.join(this.cwd, Buffer.from(addr).toString('hex'))
  }

  logCoreEvent (event, payload) {
    log.debug('Core Event', event, payload)
  }

  login (credentials, render, coreStrings) {
    // Creates a separate DB file for each login
    const cwd = this.getPath(credentials.addr)
    log.info(`Using deltachat instance ${cwd}`)
    this._dc = new DeltaChat()
    const dc = this._dc
    this.credentials = credentials
    this._render = render

    this.setCoreStrings(coreStrings)

    dc.open(cwd, err => {
      if (err) throw err
      const onReady = () => {
        log.info('Ready')
        this.ready = true
        this.configuring = false
        this.emit('ready', this.credentials)
        log.info('dc_get_info', dc.getInfo())
        render()
      }
      if (!dc.isConfigured()) {
        dc.once('ready', onReady)
        this.configuring = true
        dc.configure(addServerFlags(credentials))
        render()
      } else {
        onReady()
      }
    })

    dc.on('ALL', (event, data1, data2) => {
      log.debug('ALL event', { event, data1, data2 })
    })

    dc.on('DC_EVENT_CONFIGURE_PROGRESS', progress => {
      this.logCoreEvent('DC_EVENT_CONFIGURE_PROGRESS', progress)
      if (Number(progress) === 0) { // login failed
        this.emit('DC_EVENT_LOGIN_FAILED')
        this.logout()
      }
    })

    dc.on('DC_EVENT_IMEX_FILE_WRITTEN', (filename) => {
      this.emit('DC_EVENT_IMEX_FILE_WRITTEN', filename)
    })

    dc.on('DC_EVENT_IMEX_PROGRESS', (progress) => {
      this.emit('DC_EVENT_IMEX_PROGRESS', progress)
    })

    dc.on('DC_EVENT_CONTACTS_CHANGED', (contactId) => {
      this.logCoreEvent('DC_EVENT_CONTACTS_CHANGED', contactId)
      render()
    })

    dc.on('DC_EVENT_MSGS_CHANGED', (chatId, msgId) => {
      // Don't rerender if a draft changes
      if (msgId === 0) return
      this.logCoreEvent('DC_EVENT_MSGS_CHANGED', { chatId, msgId })
      render()
    })

    dc.on('DC_EVENT_INCOMING_MSG', (chatId, msgId) => {
      this.emit('DC_EVENT_INCOMING_MSG', chatId, msgId)
      this.logCoreEvent('DC_EVENT_INCOMING_MSG', { chatId, msgId })
      render()
    })

    dc.on('DC_EVENT_MSG_DELIVERED', (chatId, msgId) => {
      this.logCoreEvent('EVENT msg delivered', { chatId, msgId })
      render()
    })

    dc.on('DC_EVENT_MSG_FAILED', (chatId, msgId) => {
      this.logCoreEvent('EVENT msg failed to deliver', { chatId, msgId })
      render()
    })

    dc.on('DC_EVENT_MSG_READ', (chatId, msgId) => {
      this.logCoreEvent('DC_EVENT_MSG_DELIVERED', { chatId, msgId })
      render()
    })

    dc.on('DC_EVENT_WARNING', (warning) => {
      log.warn(warning)
    })

    const onError = error => {
      this.emit('error', error)
      log.error(error)
    }

    dc.on('DC_EVENT_ERROR', (error) => {
      onError(error)
    })

    dc.on('DC_EVENT_ERROR_NETWORK', (first, error) => {
      onError(error)
    })

    dc.on('DC_EVENT_ERROR_SELF_NOT_IN_GROUP', (error) => {
      onError(error)
    })
  }

  logout () {
    this.close()
    this._resetState()

    log.info('Logged out')
    this.emit('logout')
    if (typeof this._render === 'function') this._render()
  }

  close () {
    if (!this._dc) return
    this._dc.close()
    this._dc = null
  }

  getInfo () {
    if (this.ready === true) {
      return this._dc.getInfo()
    } else {
      return DeltaChat.getSystemInfo()
    }
  }

  sendMessage (chatId, text, filename, opts) {
    const viewType = filename ? C.DC_MSG_FILE : C.DC_MSG_TEXT
    const msg = this._dc.messageNew(viewType)
    if (filename) msg.setFile(filename)
    if (text) msg.setText(text)
    this._dc.sendMessage(chatId, msg)
  }

  /**
   * Update query for rendering chats with search input
   */
  searchChats (query) {
    this._query = query
    this._render()
  }

  deleteMessage (id) {
    log.info(`deleting message ${id}`)
    this._dc.deleteMessages(id)
  }

  initiateKeyTransfer (cb) {
    return this._dc.initiateKeyTransfer(cb)
  }

  continueKeyTransfer (messageId, setupCode, cb) {
    return this._dc.continueKeyTransfer(messageId, setupCode, cb)
  }

  createContact (name, email) {
    return this._dc.createContact(name, email)
  }

  chatWithContact (deadDrop) {
    log.info(`chat with dead drop ${deadDrop}`)
    const contact = this._dc.getContact(deadDrop.contact.id)
    const address = contact.getAddress()
    const name = contact.getName() || address.split('@')[0]
    this._dc.createContact(name, address)
    log.info(`Added contact ${name} (${address})`)
    const chatId = this._dc.createChatByMessageId(deadDrop.id)
    if (chatId) this.selectChat(chatId)
  }

  unblockContact (contactId) {
    const contact = this._dc.getContact(contactId)
    this._dc.blockContact(contactId, false)
    const name = contact.getNameAndAddress()
    log.info(`Unblocked contact ${name} (id = ${contactId})`)
  }

  blockContact (contactId) {
    const contact = this._dc.getContact(contactId)
    this._dc.blockContact(contactId, true)
    const name = contact.getNameAndAddress()
    log.debug(`Blocked contact ${name} (id = ${contactId})`)
  }

  createChatByContactId (contactId) {
    const contact = this._dc.getContact(contactId)
    if (!contact) {
      log.warn(`no contact could be found with id ${contactId}`)
      return 0
    }
    const chatId = this._dc.createChatByContactId(contactId)
    log.debug(`created chat ${chatId} with contact' ${contactId}`)
    const chat = this._dc.getChat(chatId)
    if (chat && chat.getArchived()) {
      log.debug('chat was archived, unarchiving it')
      this._dc.archiveChat(chatId, 0)
    }
    this.selectChat(chatId)
    return chatId
  }

  getChatContacts (chatId) {
    return this._dc.getChatContacts(chatId)
  }

  modifyGroup (chatId, name, image, remove, add) {
    log.debug('action - modify group', { chatId, name, image, remove, add })
    this._dc.setChatName(chatId, name)
    const chat = this._dc.getChat(chatId)
    if (chat.getProfileImage() !== image) {
      this._dc.setChatProfileImage(chatId, image || '')
    }
    remove.forEach(id => this._dc.removeContactFromChat(chatId, id))
    add.forEach(id => this._dc.addContactToChat(chatId, id))
    return true
  }

  deleteChat (chatId) {
    log.debug(`action - deleting chat ${chatId}`)
    this._dc.deleteChat(chatId)
  }

  archiveChat (chatId, archive) {
    log.debug(`action - archiving chat ${chatId}`)
    this._dc.archiveChat(chatId, archive)
  }

  showArchivedChats (show) {
    this._showArchivedChats = show
    this._render()
  }

  createGroupChat (verified, name, image, contactIds) {
    let chatId
    if (verified) chatId = this._dc.createVerifiedGroupChat(name)
    else chatId = this._dc.createUnverifiedGroupChat(name)
    this._dc.setChatProfileImage(chatId, image)
    contactIds.forEach(id => this._dc.addContactToChat(chatId, id))
    this.selectChat(chatId)
    return { chatId }
  }

  leaveGroup (chatId) {
    log.debug(`action - leaving chat ${chatId}`)
    this._dc.removeContactFromChat(chatId, C.DC_CONTACT_ID_SELF)
  }

  selectChat (chatId) {
    log.debug(`action - selecting chat ${chatId}`)
    this._pages = 1
    this._selectedChatId = chatId
    this._render()
  }

  /**
   * Called when this controller is created and when current
   * locale changes
   */
  setCoreStrings (strings) {
    if (!this._dc) return

    this._dc.clearStringTable()
    Object.keys(strings).forEach(key => {
      this._dc.setStringTable(Number(key), strings[key])
    })

    this._render()
  }

  getQrCode (chatId = 0) {
    return this._dc.getSecurejoinQrCode(chatId)
  }

  checkPassword (password) {
    return password === this.getConfig('mail_pw')
  }

  keysImport (directory) {
    this._dc.importExport(C.DC_IMEX_IMPORT_SELF_KEYS, directory)
  }

  keysExport (directory) {
    this._dc.importExport(C.DC_IMEX_EXPORT_SELF_KEYS, directory)
  }

  backupExport (dir) {
    this._dc.importExport(C.DC_IMEX_EXPORT_BACKUP, dir)
  }

  setConfig (key, value) {
    log.info(`Setting config ${key}:${value}`)
    return this._dc.setConfig(key, String(value))
  }

  getConfig (key) {
    return this._dc.getConfig(key)
  }

  getConfigFor (keys) {
    let config = {}
    for (let key of keys) {
      config[key] = this.getConfig(key)
    }
    return config
  }

  setLocation (latitude, longitude, accuracy) {
    log.debug(`setLocation ${latitude}`)
    let res = this._dc.setLocation(latitude, longitude, accuracy)
    log.debug(`setLocation result: ${res}`)
    return res
  }

  getLocations (chatId, contactId, timestampFrom, timestampTo) {
    log.debug(`getLocations ${chatId}`)
    let res = this._dc.getLocations(chatId, contactId, timestampFrom, timestampTo)
    log.debug(`getLocations result: ${res}`)
    return res
  }

  setDraft (chatId, msgText) {
    log.debug(`setDraft: ${msgText}, ${chatId}`)
    let msg = this._dc.messageNew()
    msg.setText(msgText)

    this._dc.setDraft(chatId, msg)
  }

  /**
   * Returns the state in json format
   */
  render () {
    let selectedChatId = this._selectedChatId
    let showArchivedChats = this._showArchivedChats

    let chatList = this._chatList(showArchivedChats)
    let selectedChat = this._selectedChat(showArchivedChats, chatList, selectedChatId)

    return {
      configuring: this.configuring,
      credentials: this.credentials,
      ready: this.ready,
      blockedContacts: this._blockedContacts(),
      showArchivedChats,
      chatList,
      selectedChat
    }
  }

  _integerToHexColor (integerColor) {
    return '#' + integerColor.toString(16)
  }

  _chatList (showArchivedChats) {
    if (!this._dc) return []

    const listFlags = showArchivedChats ? C.DC_GCL_ARCHIVED_ONLY : 0
    const list = this._dc.getChatList(listFlags, this._query)
    const listCount = list.getCount()

    const chatList = []
    for (let i = 0; i < listCount; i++) {
      const chatId = list.getChatId(i)
      const chat = this._getChatById(chatId)

      if (!chat) continue

      if (chat.id === C.DC_CHAT_ID_DEADDROP) {
        const messageId = list.getMessageId(i)
        chat.deaddrop = this._deadDropMessage(messageId)
      }

      // This is NOT the Chat Oject, it's a smaller version for use as ChatListItem in the ChatList
      chatList.push({
        id: chat.id,
        summary: list.getSummary(i).toJson(),
        name: chat.name,
        deaddrop: chat.deaddrop,
        freshMessageCounter: chat.freshMessageCounter,
        profileImage: chat.profileImage,
        color: chat.color,
        isVerified: chat.isVerified,
        isGroup: chat.isGroup
      })
    }
    return chatList
  }

  _getGeneralFreshMessageCounter () {
    const list = this._dc.getChatList(0, this._query)
    const listCount = list.getCount()

    var freshMessageCounter = 0
    for (let i = 0; i < listCount; i++) {
      const chatId = list.getChatId(i)
      const chat = this._dc.getChat(chatId).toJson()

      if (!chat) continue

      if (chat.id !== C.DC_CHAT_ID_DEADDROP) {
        freshMessageCounter += this._dc.getFreshMessageCount(chatId)
      }
    }
    return freshMessageCounter
  }

  _deadDropMessage (id) {
    const msg = this._dc.getMessage(id)
    const fromId = msg && msg.getFromId()

    if (!fromId) {
      log.warn('Ignoring DEADDROP due to missing fromId')
      return
    }

    const contact = this._dc.getContact(fromId).toJson()
    return { id, contact }
  }

  _selectedChat (showArchivedChats, chatList, selectedChatId) {
    let selectedChat = this._getChatById(selectedChatId)
    if (!selectedChat) return null
    if (selectedChat.id !== C.DC_CHAT_ID_DEADDROP) {
      if (selectedChat.freshMessageCounter > 0) {
        this._dc.markNoticedChat(selectedChat.id)
        selectedChat.freshMessageCounter = 0
      }

      if (this._saved.markRead) {
        this._dc.markSeenMessages(selectedChat.messages.map((msg) => msg.id))
      }
    }

    return selectedChat
  }

  _getChatById (chatId) {
    if (!chatId) return null
    const rawChat = this._dc.getChat(chatId)
    if (!rawChat) return null
    const chat = rawChat.toJson()
    let draft = this._dc.getDraft(chatId)
    if (draft) {
      chat.draft = draft.getText()
    } else {
      chat.draft = ''
    }
    log.debug('getDraft:', chat.draft)
    var messageIds = this._dc.getChatMessages(chat.id, C.DC_GCM_ADDDAYMARKER, 0)
    // This object is NOT created with object assign to promote consistency and to be easier to understand
    return {
      id: chat.id,
      name: chat.name,
      isVerified: chat.isVerified,
      profileImage: chat.profileImage,

      archived: chat.archived,
      subtitle: chat.subtitle,
      type: chat.type,
      isUnpromoted: chat.isUnpromoted,
      isSelfTalk: chat.isSelfTalk,

      contacts: this._dc.getChatContacts(chatId).map(id => this._dc.getContact(id).toJson()),
      totalMessages: messageIds.length,
      messages: this._messagesToRender(messageIds),
      color: this._integerToHexColor(chat.color),
      summary: undefined,
      freshMessageCounter: this._dc.getFreshMessageCount(chatId),
      isGroup: isGroupChat(chat),
      isDeaddrop: chatId === C.DC_CHAT_ID_DEADDROP,
      draft: chat.draft
    }
  }

  _messagesToRender (messageIds) {
    const countMessages = messageIds.length
    const messageIdsToRender = messageIds.splice(
      Math.max(countMessages - (this._pages * PAGE_SIZE), 0),
      countMessages
    )

    if (messageIdsToRender.length === 0) return []

    let messages = Array(messageIdsToRender.length)

    for (let i = messageIdsToRender.length - 1; i >= 0; i--) {
      let id = messageIdsToRender[i]
      let json = this.messageIdToJson(id)

      if (id === C.DC_MSG_ID_DAYMARKER) {
        json.daymarker = {
          timestamp: messages[i + 1].msg.timestamp,
          id: 'd' + i
        }
      }
      messages[i] = json
    }

    return messages
  }

  messageIdToJson (id) {
    const msg = this._dc.getMessage(id)
    const filemime = msg.getFilemime()
    const filename = msg.getFilename()
    const filesize = msg.getFilebytes()
    const fromId = msg.getFromId()
    const isMe = fromId === C.DC_CONTACT_ID_SELF
    const setupCodeBegin = msg.getSetupcodebegin()
    const contact = fromId ? this._dc.getContact(fromId).toJson() : {}
    if (contact.color) {
      contact.color = this._integerToHexColor(contact.color)
    }

    return {
      id,
      msg: msg.toJson(),
      filemime,
      filename,
      filesize,
      fromId,
      isMe,
      contact,
      isInfo: msg.isInfo(),
      setupCodeBegin
    }
  }

  fetchMessages () {
    this._pages++
    this._render()
  }

  forwardMessage (msgId, contactId) {
    const chatId = this._dc.getChatIdByContactId(contactId)
    this._dc.forwardMessages(msgId, chatId)
    this.selectChat(chatId)
  }

  _blockedContacts () {
    if (!this._dc) return []
    return this._dc.getBlockedContacts().map(id => {
      return this._dc.getContact(id).toJson()
    })
  }

  getContacts (listFlags, queryStr) {
    const distinctIds = Array.from(new Set(this._dc.getContacts(listFlags, queryStr)))
    return distinctIds.map(id => {
      return this._dc.getContact(id).toJson()
    })
  }

  contactRequests () {
    this.selectChat(C.DC_CHAT_ID_DEADDROP)
  }

  getEncrInfo (contactId) {
    return this._dc.getContactEncryptionInfo(contactId)
  }

  getChatMedia (msgType1, msgType2) {
    if (!this._selectedChatId) return
    const mediaMessages = this._dc.getChatMedia(this._selectedChatId, msgType1, msgType2)
    return mediaMessages.map(this.messageIdToJson.bind(this))
  }

  /**
   * Internal
   * Reset state related to login
   */
  _resetState () {
    this.ready = false
    this.configuring = false
    this.credentials = { addr: '' }
    this._selectedChatId = null
    this._showArchivedChats = false
    this._pages = 1
    this._query = ''
  }
}

function addServerFlags (credentials) {
  return Object.assign({}, credentials, {
    serverFlags: serverFlags(credentials)
  })
}

function isGroupChat (chat) {
  return [
    C.DC_CHAT_TYPE_GROUP,
    C.DC_CHAT_TYPE_VERIFIED_GROUP
  ].includes(chat && chat.type)
}

function serverFlags ({ mailSecurity, sendSecurity }) {
  const flags = []

  if (mailSecurity === 'ssl') {
    flags.push(C.DC_LP_IMAP_SOCKET_SSL)
  } else if (mailSecurity === 'starttls') {
    flags.push(C.DC_LP_IMAP_SOCKET_STARTTLS)
  } else if (mailSecurity === 'plain') {
    flags.push(C.DC_LP_SMTP_SOCKET_PLAIN)
  }

  if (sendSecurity === 'ssl') {
    flags.push(C.DC_LP_SMTP_SOCKET_SSL)
  } else if (sendSecurity === 'starttls') {
    flags.push(C.DC_LP_SMTP_SOCKET_STARTTLS)
  } else if (sendSecurity === 'plain') {
    flags.push(C.DC_MAX_GET_INFO_LEN)
  }

  if (!flags.length) return null

  return flags.reduce((flag, acc) => {
    return acc | flag
  }, 0)
}

if (!module.parent) {
  // TODO move this to unit tests
  console.log(serverFlags({
    mailSecurity: 'ssl',
    sendSecurity: 'ssl'
  }))
  console.log(C.DC_LP_IMAP_SOCKET_SSL | C.DC_LP_SMTP_SOCKET_SSL)
  console.log(serverFlags({
    mailSecurity: 'starttls',
    sendSecurity: 'starttls'
  }))
  console.log(C.DC_LP_IMAP_SOCKET_STARTTLS | C.DC_LP_SMTP_SOCKET_STARTTLS)
}

module.exports = DeltaChatController
