import { Protocol } from 'trac-peer';
import { bufferToBigInt, bigIntToDecimalString } from 'trac-msb/src/utils/amountSerialization.js';

class AlertProtocol extends Protocol {
  constructor(peer, base, options = {}) {
    super(peer, base, options);
  }

  async extendApi() {
    this.api.getAppInfo = function () {
      return {
        app: 'pulse-sentry',
        description: 'Alert and incident coordination on Trac subnet',
        version: 1,
      };
    };
  }

  mapTxCommand(command) {
    const cmd = String(command || '').trim();
    const obj = { type: '', value: null };

    if (cmd === 'alert_snapshot' || cmd === 'read_snapshot') {
      obj.type = 'readSnapshot';
      obj.value = null;
      return obj;
    }

    if (cmd === 'read_timer') {
      obj.type = 'readTimer';
      obj.value = null;
      return obj;
    }

    if (cmd === 'alert_list' || cmd === 'list_alerts') {
      obj.type = 'listAlerts';
      obj.value = { op: 'list_alerts', limit: 20 };
      return obj;
    }

    if (cmd.startsWith('alert_list:')) {
      const limitRaw = cmd.slice('alert_list:'.length).trim();
      const parsedLimit = Number.parseInt(limitRaw, 10);
      obj.type = 'listAlerts';
      obj.value = {
        op: 'list_alerts',
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 20,
      };
      return obj;
    }

    if (cmd.startsWith('alert_read:')) {
      const alertId = cmd.slice('alert_read:'.length).trim();
      if (!alertId) return null;
      obj.type = 'readAlert';
      obj.value = { op: 'read_alert', alertId };
      return obj;
    }

    if (cmd.startsWith('alert_status:')) {
      const status = cmd.slice('alert_status:'.length).trim().toLowerCase();
      if (!status) return null;
      obj.type = 'listAlertsByStatus';
      obj.value = { op: 'list_alerts_by_status', status, limit: 20 };
      return obj;
    }

    const json = this.safeJsonParse(cmd);
    if (!json || typeof json !== 'object') return null;

    const op = String(json.op || '').trim().toLowerCase();
    if (!op) return null;

    if (op === 'alert_raise') {
      obj.type = 'alertRaise';
      obj.value = json;
      return obj;
    }
    if (op === 'alert_ack') {
      obj.type = 'alertAck';
      obj.value = json;
      return obj;
    }
    if (op === 'alert_resolve') {
      obj.type = 'alertResolve';
      obj.value = json;
      return obj;
    }
    if (op === 'read_alert') {
      obj.type = 'readAlert';
      obj.value = json;
      return obj;
    }
    if (op === 'list_alerts') {
      obj.type = 'listAlerts';
      obj.value = json;
      return obj;
    }
    if (op === 'list_alerts_by_status') {
      obj.type = 'listAlertsByStatus';
      obj.value = json;
      return obj;
    }
    if (op === 'read_snapshot') {
      obj.type = 'readSnapshot';
      obj.value = null;
      return obj;
    }

    return null;
  }

  async printOptions() {
    console.log(' ');
    console.log('- Pulse Sentry Commands:');
    console.log('- /alert_examples | print ready /tx payloads for alert lifecycle.');
    console.log('- /alert_wizard | terminal quick menu for first-time users.');
    console.log('- /get --key "<key>" [--confirmed true|false] | read subnet state key.');
    console.log('- /msb | show local MSB node info and balance estimate.');
    console.log('- /tx --command "alert_snapshot" | alert counters + last alert.');
    console.log('- /tx --command "alert_list" | latest alerts (default limit=20).');
    console.log('- /tx --command "alert_list:50" | latest alerts with explicit limit.');
    console.log('- /tx --command "alert_read:alert-001" | one alert details.');
    console.log('- /tx --command "alert_status:open" | filter by status.');
    console.log('- /tx --command \'' + JSON.stringify({ op: 'alert_raise', alertId: 'alert-001', title: 'Indexer lag', severity: 'high', message: 'Indexer peer is 200 blocks behind', channel: 'ops/indexer' }) + '\'');
    console.log('- /tx --command \'' + JSON.stringify({ op: 'alert_ack', alertId: 'alert-001', note: 'On-call investigating' }) + '\'');
    console.log('- /tx --command \'' + JSON.stringify({ op: 'alert_resolve', alertId: 'alert-001', resolution: 'Indexer restarted and synced' }) + '\'');
    console.log('- /tx --command "read_timer" | prints timer feature value if available.');
  }

  async customCommand(input) {
    await super.tokenizeInput(input);

    if (this.input.startsWith('/alert_examples')) {
      console.log('Pulse Sentry /tx examples:');
      console.log('/tx --command \'' + JSON.stringify({ op: 'alert_raise', alertId: 'alert-001', title: 'Indexer lag', severity: 'high', message: 'Indexer peer is 200 blocks behind', channel: 'ops/indexer', tags: ['indexer', 'sync'] }) + '\'');
      console.log('/tx --command \'' + JSON.stringify({ op: 'alert_ack', alertId: 'alert-001', note: 'On-call investigating' }) + '\'');
      console.log('/tx --command \'' + JSON.stringify({ op: 'alert_resolve', alertId: 'alert-001', resolution: 'Indexer restarted and synced' }) + '\'');
      console.log('/tx --command "alert_snapshot"');
      console.log('/tx --command "alert_list:50"');
      console.log('/tx --command "alert_status:open"');
      console.log('/tx --command "alert_read:alert-001"');
      return;
    }

    if (this.input.startsWith('/alert_wizard')) {
      console.log('Alert Wizard (terminal UI):');
      console.log('1) Raise alert   -> /tx --command ' + JSON.stringify({ op: 'alert_raise', alertId: 'alert-001', title: 'Indexer lag', severity: 'high', message: 'Indexer peer is 200 blocks behind', channel: 'ops/indexer' }));
      console.log('2) Acknowledge   -> /tx --command ' + JSON.stringify({ op: 'alert_ack', alertId: 'alert-001', note: 'On-call investigating' }));
      console.log('3) Resolve       -> /tx --command ' + JSON.stringify({ op: 'alert_resolve', alertId: 'alert-001', resolution: 'Indexer restarted and synced' }));
      return;
    }

    if (this.input.startsWith('/get')) {
      const m = input.match(/(?:^|\s)--key(?:=|\s+)("[^"]+"|'[^']+'|\S+)/);
      const raw = m ? m[1].trim() : null;
      if (!raw) {
        console.log('Usage: /get --key "<hyperbee-key>" [--confirmed true|false] [--unconfirmed 1]');
        return;
      }
      const key = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      const confirmedMatch = input.match(/(?:^|\s)--confirmed(?:=|\s+)(\S+)/);
      const unconfirmedMatch = input.match(/(?:^|\s)--unconfirmed(?:=|\s+)?(\S+)?/);
      const confirmed = unconfirmedMatch
        ? false
        : confirmedMatch
          ? confirmedMatch[1] === 'true' || confirmedMatch[1] === '1'
          : true;
      const value = confirmed ? await this.getSigned(key) : await this.get(key);
      console.log(value);
      return;
    }

    if (this.input.startsWith('/msb')) {
      const txv = await this.peer.msbClient.getTxvHex();
      const peerMsbAddress = this.peer.msbClient.pubKeyHexToAddress(this.peer.wallet.publicKey);
      const entry = await this.peer.msbClient.getNodeEntryUnsigned(peerMsbAddress);
      const balance = entry?.balance ? bigIntToDecimalString(bufferToBigInt(entry.balance)) : 0;
      const feeBuf = this.peer.msbClient.getFee();
      const fee = feeBuf ? bigIntToDecimalString(bufferToBigInt(feeBuf)) : 0;
      console.log({
        networkId: this.peer.msbClient.networkId,
        txv,
        msbSignedLength: this.peer.msbClient.getSignedLength(),
        msbUnsignedLength: this.peer.msbClient.getUnsignedLength(),
        connectedValidators: this.peer.msbClient.getConnectedValidatorsCount(),
        peerMsbAddress,
        peerMsbBalance: balance,
        msbFee: fee,
      });
      return;
    }
  }
}

export default AlertProtocol;

