import { Contract } from 'trac-peer';

const VALID_TRANSITIONS = {
  open: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

class AlertContract extends Contract {
  constructor(protocol, options = {}) {
    super(protocol, options);

    this.addSchema('alertRaise', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        alertId: { type: 'string', min: 3, max: 64 },
        title: { type: 'string', min: 3, max: 180 },
        severity: { type: 'string', min: 1, max: 16 },
        message: { type: 'string', min: 1, max: 4000 },
        channel: { type: 'string', min: 1, max: 160, optional: true },
        tags: { type: 'array', items: 'string', max: 20, optional: true },
        ts: { type: 'number', integer: true, optional: true },
      },
    });

    this.addSchema('alertAck', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        alertId: { type: 'string', min: 3, max: 64 },
        note: { type: 'string', min: 1, max: 1000, optional: true },
        ts: { type: 'number', integer: true, optional: true },
      },
    });

    this.addSchema('alertResolve', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        alertId: { type: 'string', min: 3, max: 64 },
        resolution: { type: 'string', min: 1, max: 1500, optional: true },
        ts: { type: 'number', integer: true, optional: true },
      },
    });

    this.addSchema('readAlert', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        alertId: { type: 'string', min: 3, max: 64 },
      },
    });

    this.addSchema('listAlerts', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        limit: { type: 'number', integer: true, min: 1, max: 200, optional: true },
      },
    });

    this.addSchema('listAlertsByStatus', {
      value: {
        $$strict: true,
        $$type: 'object',
        op: { type: 'string', min: 1, max: 64 },
        status: { type: 'string', min: 1, max: 64 },
        limit: { type: 'number', integer: true, min: 1, max: 200, optional: true },
      },
    });

    this.addFunction('readSnapshot');
    this.addFunction('readTimer');

    this.addSchema('feature_entry', {
      key: { type: 'string', min: 1, max: 256 },
      value: { type: 'any' },
    });

    const self = this;
    this.addFeature('timer_feature', async function () {
      if (self.check.validateSchema('feature_entry', self.op) === false) return;
      if (self.op.key === 'currentTime') {
        await self.put('currentTime', self.op.value);
      }
    });
  }

  _alertKey(alertId) {
    return `alert/${alertId}`;
  }

  _normalizeAlertId(rawAlertId) {
    return String(rawAlertId || '').trim();
  }

  _normalizeSeverity(rawSeverity) {
    const value = String(rawSeverity || '').trim().toLowerCase();
    const allowed = new Set(['low', 'medium', 'high', 'critical']);
    return allowed.has(value) ? value : null;
  }

  async _now() {
    const timerTime = await this.get('currentTime');
    if (typeof timerTime === 'number') return timerTime;
    const fromTx = Number.parseInt(String(this.value?.ts ?? ''), 10);
    return Number.isFinite(fromTx) ? fromTx : null;
  }

  async _readAlert(alertId) {
    return await this.get(this._alertKey(alertId));
  }

  async _readAlertIndex() {
    const index = await this.get('alert_index');
    return Array.isArray(index) ? index : [];
  }

  async _writeAlert(alertId, alert) {
    await this.put(this._alertKey(alertId), alert);
    await this.put('alert_last', alert);
  }

  _canTransition(from, to) {
    const next = VALID_TRANSITIONS[from] || [];
    return next.includes(to);
  }

  _isRaiser(alert) {
    return alert?.raisedBy && this.address && alert.raisedBy === this.address;
  }

  _isAcker(alert) {
    return alert?.ack?.by && this.address && alert.ack.by === this.address;
  }

  async alertRaise() {
    const alertId = this._normalizeAlertId(this.value?.alertId);
    if (!alertId) return new Error('Missing alertId.');
    if (!this.address) return new Error('Missing sender address.');

    const severity = this._normalizeSeverity(this.value?.severity);
    if (!severity) return new Error('severity must be low|medium|high|critical.');

    const existing = await this._readAlert(alertId);
    if (existing !== null) return new Error(`Alert already exists: ${alertId}`);

    const now = await this._now();
    const alert = {
      alertId,
      title: String(this.value?.title || '').trim(),
      severity,
      message: String(this.value?.message || '').trim(),
      channel: this.value?.channel ? String(this.value.channel).trim() : null,
      tags: Array.isArray(this.value?.tags)
        ? this.value.tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0)
        : [],
      status: 'open',
      raisedBy: this.address,
      raisedAt: now,
      updatedAt: now,
      ack: null,
      resolved: null,
    };

    const index = await this._readAlertIndex();
    if (index.includes(alertId) === false) index.push(alertId);

    await this._writeAlert(alertId, alert);
    await this.put('alert_index', index);

    console.log('alert_raise ok', { alertId, by: this.address, severity });
  }

  async alertAck() {
    const alertId = this._normalizeAlertId(this.value?.alertId);
    if (!alertId) return new Error('Missing alertId.');
    if (!this.address) return new Error('Missing sender address.');

    const alert = await this._readAlert(alertId);
    if (alert === null) return new Error(`Alert not found: ${alertId}`);
    if (alert.status !== 'open') return new Error(`Alert is not open: ${alert.status}`);
    if (!this._canTransition(alert.status, 'acknowledged')) return new Error('Invalid transition.');

    const now = await this._now();
    alert.status = 'acknowledged';
    alert.updatedAt = now;
    alert.ack = {
      by: this.address,
      at: now,
      note: this.value?.note ? String(this.value.note).trim() : null,
    };

    await this._writeAlert(alertId, alert);
    console.log('alert_ack ok', { alertId, by: this.address });
  }

  async alertResolve() {
    const alertId = this._normalizeAlertId(this.value?.alertId);
    if (!alertId) return new Error('Missing alertId.');
    if (!this.address) return new Error('Missing sender address.');

    const alert = await this._readAlert(alertId);
    if (alert === null) return new Error(`Alert not found: ${alertId}`);
    if (alert.status !== 'open' && alert.status !== 'acknowledged') {
      return new Error(`Alert cannot be resolved from: ${alert.status}`);
    }

    if (!this._isRaiser(alert) && !this._isAcker(alert)) {
      return new Error('Only raiser or acknowledger can resolve alert.');
    }

    if (!this._canTransition(alert.status, 'resolved')) return new Error('Invalid transition.');

    const now = await this._now();
    alert.status = 'resolved';
    alert.updatedAt = now;
    alert.resolved = {
      by: this.address,
      at: now,
      resolution: this.value?.resolution ? String(this.value.resolution).trim() : null,
    };

    await this._writeAlert(alertId, alert);
    console.log('alert_resolve ok', { alertId, by: this.address });
  }

  async readAlert() {
    const alertId = this._normalizeAlertId(this.value?.alertId);
    if (!alertId) return new Error('Missing alertId.');

    const alert = await this._readAlert(alertId);
    console.log('read_alert', { alertId, alert });
  }

  async listAlerts() {
    const index = await this._readAlertIndex();
    const requested = Number.parseInt(String(this.value?.limit ?? '20'), 10);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 200)) : 20;

    const items = [];
    for (let i = index.length - 1; i >= 0 && items.length < limit; i -= 1) {
      const alertId = index[i];
      const alert = await this._readAlert(alertId);
      if (alert !== null) items.push(alert);
    }

    console.log('list_alerts', { total: index.length, limit, items });
  }

  async listAlertsByStatus() {
    const status = String(this.value?.status || '').trim().toLowerCase();
    if (!status) return new Error('Missing status.');

    const index = await this._readAlertIndex();
    const requested = Number.parseInt(String(this.value?.limit ?? '20'), 10);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 200)) : 20;

    const items = [];
    for (let i = index.length - 1; i >= 0 && items.length < limit; i -= 1) {
      const alertId = index[i];
      const alert = await this._readAlert(alertId);
      if (alert && String(alert.status || '').toLowerCase() === status) {
        items.push(alert);
      }
    }

    console.log('list_alerts_by_status', { status, total: items.length, limit, items });
  }

  async readSnapshot() {
    const currentTime = await this.get('currentTime');
    const alertIndex = await this._readAlertIndex();
    const alertLast = await this.get('alert_last');
    console.log('alert_snapshot', {
      alertCount: alertIndex.length,
      alertLast,
      currentTime,
    });
  }

  async readTimer() {
    const currentTime = await this.get('currentTime');
    console.log('currentTime:', currentTime);
  }
}

export default AlertContract;
