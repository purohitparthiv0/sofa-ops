/**
 * SHREE GAYATRI FURNISHING HUB - v6 WITH UPGRADES A, B, C, D, E, F
 * Defensive null-safe architecture, integer quarter-foot math, backward-compatible with old v6 orders.
 */

const App = (() => {
  // Default Supabase credentials (can also be set in Settings or window.SUPABASE_URL)
  const DEFAULT_SUPABASE_URL = window.SUPABASE_URL || localStorage.getItem('sgf_supabase_url') || '';
  const DEFAULT_SUPABASE_KEY = window.SUPABASE_KEY || localStorage.getItem('sgf_supabase_key') || '';

  let supabaseClient = null;
  let currentUser = null; // { role: 'Admin' | 'Sales' | 'Cutting' | 'Tailor' }
  let currentTab = 'dashboard';
  let showDoneNotes = false;

  // In-memory state synced with localStorage + Supabase
  let state = {
    orders: [],
    notes: [],
    devices: [],
    settings: {
      shop_name: 'Shree Gayatri Furnishing Hub',
      shop_phone: '9825000000',
      shop_phone_2: '',
      pins: { Admin: '1234', Sales: '1111', Cutting: '2222', Tailor: '3333' },
      device_approval_enabled: false,
      templates: getDefaultTemplates()
    }
  };

  // Current form state for New / Edit Order
  let formState = {
    id: null,
    lines: [],
    shape: { template: 'None', unit: 'in', sides: {} },
    special_cuts: [],
    sketch_photo: null
  };

  // Modal state trackers
  let activeWaOrder = null;
  let pendingAdminAction = null; // { type, orderId }

  // ==========================================================================
  // DEFAULT WHATSAPP TEMPLATES (HINGLISH + MANDATORY RECEIPT TERMS)
  // ==========================================================================
  function getDefaultTemplates() {
    return {
      estimate: {
        lang: 'Hinglish',
        text:
          'Namaste {customer} ji,\n' +
          '*Shree Gayatri Furnishing Hub* se aapka Sofa/Furnishing Estimate:\n\n' +
          '{lines}\n\n' +
          '*Estimated Total:* Rs {total}\n' +
          'Koi bhi sawal ho to call karein: {shop_phone}'
      },
      receipt: {
        lang: 'Hinglish',
        text:
          'Namaste {customer} ji,\n' +
          '*Shree Gayatri Furnishing Hub* - Order Receipt ({order_no})\n\n' +
          '{lines}\n\n' +
          '*Total:* Rs {total}\n' +
          '*Advance:* Rs {advance}\n' +
          '*Balance:* Rs {balance}\n' +
          '*Promised Date:* {promised_date}\n\n' +
          '*Important Terms:*\n' +
          '1. Do not wash in hot water (Garam pani me wash na karein).\n' +
          '2. Do not machine-dry/spin (Machine-dry ya spin na karein).\n' +
          '3. For delivery you must go to the 3rd floor (Delivery ke liye 3rd floor par aana hoga).\n' +
          '4. Advance is non-refundable (Advance non-refundable hai).\n\n' +
          'Contact: {shop_phone}'
      },
      ready: {
        lang: 'Hinglish',
        text:
          'Namaste {customer} ji,\n' +
          'Aapka Order *{order_no}* (*Shree Gayatri Furnishing Hub*) bankar READY hai!\n' +
          'Balance Amount: *Rs {balance}*\n' +
          'Note: Delivery ke liye 3rd floor par aana hoga.\n' +
          'Contact: {shop_phone}'
      },
      reminder: {
        lang: 'Hinglish',
        text:
          'Namaste {customer} ji,\n' +
          '*Shree Gayatri Furnishing Hub* Order *{order_no}* ka payment reminder:\n' +
          'Total: Rs {total} | Advance: Rs {advance}\n' +
          '*Pending Balance: Rs {balance}*\n' +
          'Kripya balance clear kar ke delivery le jaayein. Contact: {shop_phone}'
      },
      delivered: {
        lang: 'Hinglish',
        text:
          'Dhanyawad {customer} ji!\n' +
          'Aapka Order *{order_no}* (*Shree Gayatri Furnishing Hub*) deliver ho gaya hai.\n' +
          'Care: Garam pani me wash na karein, machine-dry/spin na karein.\n' +
          'Contact: {shop_phone}'
      }
    };
  }

  // ==========================================================================
  // SAFE UTILITIES & NULL CHECKS
  // ==========================================================================
  function safeEl(id) {
    return document.getElementById(id) || null;
  }

  function safeId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return obj.id ?? obj.order_id ?? obj.order_no ?? null;
  }

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatRs(num) {
    const n = Math.floor(Number(num) || 0);
    return n.toLocaleString('en-IN');
  }

  function showAlert(msg, type = 'info') {
    const bar = safeEl('globalAlertBar');
    const txt = safeEl('globalAlertText');
    if (!bar || !txt) return;
    txt.textContent = msg;
    bar.className = `alert-bar ${type}`;
    clearTimeout(bar._timer);
    bar._timer = setTimeout(() => hideAlert(), 5000);
  }

  function hideAlert() {
    const bar = safeEl('globalAlertBar');
    if (bar) bar.classList.add('hidden');
  }

  // ==========================================================================
  // FEATURE A: EXACT INTEGER MATHS & EXPRESSION PARSER
  // ==========================================================================
  /**
   * Parses length input supporting:
   * - "102+102+36+78+24" -> 342
   * - "24x4" or "24×4" -> 96
   * - Decimals e.g. "36.5+24.5" -> 61
   */
  function parseLengthExpr(rawStr) {
    const str = String(rawStr ?? '').trim();
    if (!str) return { totalInches: 0, display: '0"' };

    const plusParts = str.split('+').map(s => s.trim()).filter(Boolean);
    let total = 0;

    for (const part of plusParts) {
      if (/[x×*]/i.test(part)) {
        const factors = part.split(/[x×*]/i).map(f => parseFloat(f.trim()));
        if (factors.length >= 2 && factors.every(f => !isNaN(f) && f >= 0)) {
          const prod = factors.reduce((acc, v) => acc * v, 1);
          total += prod;
        }
      } else {
        const val = parseFloat(part);
        if (!isNaN(val) && val >= 0) {
          total += val;
        }
      }
    }

    total = Math.round(total * 1000) / 1000;
    return { totalInches: total, display: `${str}"` };
  }

  /**
   * Calculates a single Order Line according to exact rules:
   * Feet = ceil(total_inches / 3) / 4 using integer maths (round UP to .25 ft).
   * Amount = feet x rate, rounded DOWN to whole rupees (28.50 x 275 = 7,837.50 -> 7,837).
   * Pcs line: pcs x rate.
   * Width never affects price.
   */
  function calculateLine(line) {
    if (!line || typeof line !== 'object') {
      return { totalInches: 0, feet: 0, pcs: 0, amount: 0, summaryText: '' };
    }

    const rate = Math.max(0, parseFloat(line.rate) || 0);
    const unit = line.unit === 'pcs' ? 'pcs' : 'inches_ft';
    const segments = Array.isArray(line.segments) ? line.segments : [];

    let totalInches = 0;
    const segDescriptions = [];

    for (const seg of segments) {
      const parsed = parseLengthExpr(seg?.length_expr ?? seg?.length ?? '');
      totalInches += parsed.totalInches;
      if (parsed.totalInches > 0 || String(seg?.length_expr || '').trim()) {
        const rawL = String(seg?.length_expr ?? parsed.totalInches).trim();
        const w = String(seg?.width ?? '').trim();
        const lbl = String(seg?.label ?? '').trim();
        let desc = w ? `${rawL}"x${w}"` : `${rawL}"`;
        if (lbl) desc += ` (${lbl})`;
        segDescriptions.push(desc);
      }
    }

    totalInches = Math.round(totalInches * 1000) / 1000;

    if (unit === 'pcs') {
      const pcsCount = totalInches > 0 ? totalInches : (parseFloat(line.pcs_count) || 0);
      const amount = Math.floor(pcsCount * rate + 1e-9);
      return {
        totalInches: pcsCount,
        feet: 0,
        pcs: pcsCount,
        amount,
        segJoined: segDescriptions.join(' + ') || `${pcsCount} pcs`,
        calcDisplay: `${pcsCount} Pcs × ₹${rate} = ₹${formatRs(amount)}`
      };
    }

    // Integer quarter-feet calculation: ceil(total_inches / 3)
    const quarterFeet = totalInches > 0 ? Math.ceil((totalInches - 1e-9) / 3) : 0;
    const feet = quarterFeet / 4;
    // Exact integer-friendly floor for amount:
    // Using Math.floor((quarterFeet * rate) / 4 + 1e-9)
    const amount = Math.floor((quarterFeet * rate) / 4 + 1e-9);

    return {
      totalInches,
      feet,
      pcs: segments.length,
      amount,
      segJoined: segDescriptions.join(' + ') || '0"',
      calcDisplay: `${totalInches}" → ${feet.toFixed(2)} ft × ₹${rate} = ₹${formatRs(amount)}`
    };
  }

  function getLinePartName(line) {
    if (!line) return 'Part';
    if (line.part === 'Other') {
      return (line.custom_part || 'Other').trim();
    }
    return line.part || 'Seating';
  }

  /**
   * Formats a line for Sticker, Cutting & Tailor screens:
   * "Part - Design - 102"x36" + ..."
   */
  function formatLineForWorkScreen(line) {
    const calc = calculateLine(line);
    const partName = getLinePartName(line);
    const design = (line?.design || 'Standard').trim();
    const pendingTag = line?.measurement_pending ? ' [MEASUREMENT PENDING]' : '';
    return `${partName} - ${design} - ${calc.segJoined} (${
      line?.unit === 'pcs' ? `${calc.pcs} pcs` : `${calc.feet.toFixed(2)} ft`
    })${pendingTag}`;
  }

  /**
   * Formats a line for WhatsApp Receipt:
   * e.g. "Seating - Ronaldo Cream: 9.75 ft x Rs 225 = Rs 2,193"
   */
  function formatLineForReceipt(line) {
    const calc = calculateLine(line);
    const partName = getLinePartName(line);
    const design = (line?.design || 'Standard').trim();
    const rate = parseFloat(line?.rate) || 0;
    if (line?.unit === 'pcs') {
      return `${partName} - ${design}: ${calc.pcs} pcs x Rs ${rate} = Rs ${formatRs(calc.amount)}`;
    }
    return `${partName} - ${design}: ${calc.feet.toFixed(2)} ft x Rs ${rate} = Rs ${formatRs(calc.amount)}`;
  }

  // ==========================================================================
  // BACKWARD COMPATIBILITY FOR OLD v6 ORDERS (WITHOUT lines)
  // ==========================================================================
  function normalizeOrder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ord = { ...raw };
    ord.id = String(ord.id ?? ord.order_id ?? ord.order_no ?? uid('ord'));
    ord.order_no = String(ord.order_no ?? ord.orderNo ?? `SGF-${ord.id.slice(-4)}`);
    ord.customer = String(ord.customer ?? ord.customer_name ?? 'Walk-in Customer');
    ord.phone = String(ord.phone ?? ord.mobile ?? '');
    ord.status = String(ord.status ?? 'Pending');

    // Legacy v6 orders without `lines` array: synthesize compatible line view while keeping old fields
    if (!Array.isArray(ord.lines) || ord.lines.length === 0) {
      const legacyDesign = ord.design || ord.fabric || 'v6 Order';
      const legacyRate = parseFloat(ord.rate) || 0;
      const legacyInches = parseFloat(ord.total_inches ?? ord.inches ?? 0);
      const legacyFeet = parseFloat(ord.feet ?? 0);
      const legacyAmount = Math.floor(parseFloat(ord.total ?? ord.amount ?? 0));
      ord._isLegacyV6 = true;
      ord.lines = [
        {
          id: 'legacy_line_1',
          part: ord.part || 'Seating',
          custom_part: '',
          design: legacyDesign,
          rate: legacyRate,
          unit: ord.unit === 'pcs' ? 'pcs' : 'inches_ft',
          measurement_pending: Boolean(ord.measurement_pending),
          segments: [
            {
              id: 'legacy_seg_1',
              length_expr: legacyInches > 0 ? String(legacyInches) : String(ord.measurements || '0'),
              width: String(ord.width || ''),
              label: 'v6'
            }
          ],
          _legacyFeet: legacyFeet,
          _legacyAmount: legacyAmount
        }
      ];
    }

    // Calculate totals safely
    let computedTotal = 0;
    for (const l of ord.lines) {
      const c = calculateLine(l);
      if (ord._isLegacyV6 && l._legacyAmount > 0 && c.amount === 0) {
        computedTotal += l._legacyAmount;
      } else {
        computedTotal += c.amount;
      }
    }

    ord.total = computedTotal > 0 ? computedTotal : Math.floor(parseFloat(ord.total ?? ord.amount ?? 0));
    ord.advance = Math.floor(parseFloat(ord.advance ?? 0));
    ord.balance = ord.total - ord.advance;
    ord.special_cuts = Array.isArray(ord.special_cuts) ? ord.special_cuts : [];
    ord.action_logs = Array.isArray(ord.action_logs) ? ord.action_logs : [];
    ord.is_archived = Boolean(ord.is_archived);
    ord.is_deleted = Boolean(ord.is_deleted);
    return ord;
  }

  // ==========================================================================
  // DEVICE ID & APPROVAL MANAGEMENT (FEATURE D)
  // ==========================================================================
  function getCurrentDeviceId() {
    let devId = localStorage.getItem('sgf_device_id');
    if (!devId) {
      devId = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      localStorage.setItem('sgf_device_id', devId);
    }
    return devId;
  }

  function getDeviceDescription() {
    const ua = navigator.userAgent || 'Browser';
    const platform = navigator.platform || 'Device';
    return `${platform} (${ua.slice(0, 45)}...)`;
  }

  function ensureDeviceRegistered(role, autoApprove = false) {
    const devId = getCurrentDeviceId();
    let existing = state.devices.find(d => d && d.device_id === devId);
    if (!existing) {
      existing = {
        device_id: devId,
        device_name: getDeviceDescription(),
        role_used: role || 'Staff',
        status: autoApprove || !state.settings.device_approval_enabled ? 'approved' : 'pending',
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      };
      state.devices.push(existing);
    } else {
      existing.last_seen_at = new Date().toISOString();
      if (role) existing.role_used = role;
      if (autoApprove) existing.status = 'approved';
    }
    saveLocalState();
    syncDeviceToSupabase(existing);
    return existing;
  }

  function isCurrentDeviceApproved() {
    if (!state.settings.device_approval_enabled) return true;
    const devId = getCurrentDeviceId();
    const found = state.devices.find(d => d && d.device_id === devId);
    return Boolean(found && found.status === 'approved');
  }

  // ==========================================================================
  // SUPABASE & LOCAL PERSISTENCE
  // ==========================================================================
  function initSupabase() {
    const url = localStorage.getItem('sgf_supabase_url') || DEFAULT_SUPABASE_URL;
    const key = localStorage.getItem('sgf_supabase_key') || DEFAULT_SUPABASE_KEY;
    if (url && key && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(url, key, {
          global: {
            headers: { 'x-device-id': getCurrentDeviceId() }
          }
        });
      } catch (err) {
        console.warn('Supabase init warning:', err);
      }
    }
  }

  function loadLocalState() {
    try {
      const rawOrders = localStorage.getItem('sgf_v6_orders');
      const rawNotes = localStorage.getItem('sgf_v6_notes');
      const rawDevices = localStorage.getItem('sgf_v6_devices');
      const rawSettings = localStorage.getItem('sgf_v6_settings');

      if (rawOrders) {
        const parsed = JSON.parse(rawOrders);
        if (Array.isArray(parsed)) {
          state.orders = parsed.map(normalizeOrder).filter(Boolean);
        }
      }
      if (rawNotes) {
        const parsedN = JSON.parse(rawNotes);
        if (Array.isArray(parsedN)) state.notes = parsedN;
      }
      if (rawDevices) {
        const parsedD = JSON.parse(rawDevices);
        if (Array.isArray(parsedD)) state.devices = parsedD;
      }
      if (rawSettings) {
        const parsedS = JSON.parse(rawSettings);
        if (parsedS && typeof parsedS === 'object') {
          state.settings = {
            ...state.settings,
            ...parsedS,
            pins: { ...state.settings.pins, ...(parsedS.pins || {}) },
            templates: { ...getDefaultTemplates(), ...(parsedS.templates || {}) }
          };
        }
      }
    } catch (e) {
      console.error('Local state load error:', e);
    }
  }

  function saveLocalState() {
    try {
      localStorage.setItem('sgf_v6_orders', JSON.stringify(state.orders));
      localStorage.setItem('sgf_v6_notes', JSON.stringify(state.notes));
      localStorage.setItem('sgf_v6_devices', JSON.stringify(state.devices));
      localStorage.setItem('sgf_v6_settings', JSON.stringify(state.settings));
    } catch (e) {
      showAlert('Storage warning: ' + (e?.message || 'Quota reached'), 'error');
    }
  }

  async function syncAll() {
    if (!supabaseClient) {
      renderAll();
      return;
    }
    try {
      // Load settings & devices first
      const { data: devData } = await supabaseClient.from('registered_devices').select('*');
      if (Array.isArray(devData) && devData.length > 0) {
        state.devices = devData;
      }
      const { data: setRows } = await supabaseClient.from('app_settings').select('*');
      if (Array.isArray(setRows)) {
        for (const r of setRows) {
          if (r?.key === 'device_approval' && r?.value) {
            state.settings.device_approval_enabled = Boolean(r.value.enabled);
          }
          if (r?.key === 'general_settings' && r?.value) {
            state.settings = { ...state.settings, ...r.value };
          }
        }
      }

      // Check device approval gate
      if (currentUser && state.settings.device_approval_enabled && !isCurrentDeviceApproved()) {
        showDevicePendingScreen();
        return;
      }

      const { data: ordData, error: ordErr } = await supabaseClient
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });
      if (!ordErr && Array.isArray(ordData)) {
        state.orders = ordData.map(normalizeOrder).filter(Boolean);
      }

      const { data: noteData } = await supabaseClient
        .from('important_notes')
        .select('*')
        .order('created_at', { ascending: false });
      if (Array.isArray(noteData)) {
        state.notes = noteData;
      }

      saveLocalState();
      renderAll();
      showAlert('Synced with server', 'success');
    } catch (err) {
      showAlert('Server sync warning: ' + (err?.message || 'Working offline'), 'error');
    }
  }

  async function saveOrderToServer(orderObj) {
    if (!orderObj) return true;
    saveLocalState();
    if (!supabaseClient) return true;
    try {
      const payload = { ...orderObj };
      delete payload._isLegacyV6;
      const { error } = await supabaseClient.from('orders').upsert(payload, { onConflict: 'id' });
      if (error) {
        showAlert('Server note: Saved locally (' + error.message + '). Your form data is safe.', 'error');
      }
      return true;
    } catch (err) {
      showAlert('Network warning: Saved locally (' + (err?.message || 'Offline') + ').', 'error');
      return true;
    }
  }

  async function syncDeviceToSupabase(dev) {
    if (!supabaseClient || !dev) return;
    try {
      await supabaseClient.from('registered_devices').upsert(dev, { onConflict: 'device_id' });
    } catch (_) {}
  }

  // ==========================================================================
  // LOGIN, ROLES & DEVICE APPROVAL FLOW
  // ==========================================================================
  function login() {
    const role = safeEl('loginRole')?.value || 'Sales';
    const pin = (safeEl('loginPin')?.value || '').trim();
    const expectedPin = state.settings.pins?.[role] || '1234';

    if (pin !== expectedPin) {
      showAlert('Invalid PIN for ' + role, 'error');
      return;
    }

    currentUser = { role };
    const dev = ensureDeviceRegistered(role, !state.settings.device_approval_enabled);

    if (state.settings.device_approval_enabled && dev.status !== 'approved') {
      showDevicePendingScreen();
      return;
    }

    enterAppScreen();
  }

  function showDevicePendingScreen() {
    safeEl('loginScreen')?.classList.remove('active');
    safeEl('appScreen')?.classList.remove('active');
    safeEl('devicePendingScreen')?.classList.add('active');
    safeEl('pendingDeviceId').textContent = getCurrentDeviceId();
    safeEl('pendingDeviceName').textContent = getDeviceDescription();
    safeEl('pendingDeviceRole').textContent = currentUser?.role || '-';
  }

  async function recheckDeviceApproval() {
    await syncAll();
    if (isCurrentDeviceApproved()) {
      safeEl('devicePendingScreen')?.classList.remove('active');
      enterAppScreen();
      showAlert('Device approved! Welcome.', 'success');
    } else {
      showAlert('Still waiting for Admin approval.', 'info');
    }
  }

  function enterAppScreen() {
    safeEl('loginScreen')?.classList.remove('active');
    safeEl('devicePendingScreen')?.classList.remove('active');
    safeEl('appScreen')?.classList.add('active');

    const role = currentUser?.role || 'Sales';
    safeEl('roleBadge').textContent = role;

    // Role visibility rules:
    // - Admin: all tabs, Important Notes Board, Archived, Trash, Settings
    // - Sales: Home, New Order, Cutting, Tailor, Reports, Important Notes Board
    // - Cutting: Cutting tab default; does NOT see Important Notes Board
    // - Tailor: Tailor tab default; does NOT see Important Notes Board
    const isAdmin = role === 'Admin';
    const canSeeNotes = role === 'Admin' || role === 'Sales';

    document.querySelectorAll('.admin-only').forEach(el => {
      el.classList.toggle('hidden', !isAdmin);
    });

    safeEl('importantNotesBoard')?.classList.toggle('hidden', !canSeeNotes);
    safeEl('btnNotesTop')?.classList.toggle('hidden', !canSeeNotes);

    if (role === 'Cutting') {
      switchTab('cutting');
    } else if (role === 'Tailor') {
      switchTab('tailor');
    } else {
      switchTab('dashboard');
    }

    renderAll();
  }

  function logout() {
    currentUser = null;
    safeEl('loginPin').value = '';
    safeEl('appScreen')?.classList.remove('active');
    safeEl('devicePendingScreen')?.classList.remove('active');
    safeEl('loginScreen')?.classList.add('active');
  }

  function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.toggle('active', view.id === `tab-${tabName}`);
    });
    renderAll();
  }

  // ==========================================================================
  // ORDER FORM: LINES, SEGMENTS, WIDTH CHIPS & LIVE CALCULATION
  // ==========================================================================
  function getNextOrderNo() {
    const nums = state.orders
      .map(o => {
        const m = String(o?.order_no || '').match(/(\d+)/);
        return m ? parseInt(m[1], 10) : 1000;
      })
      .filter(n => !isNaN(n));
    const maxNum = nums.length > 0 ? Math.max(...nums) : 1000;
    return `SGF-${maxNum + 1}`;
  }

  function createEmptySegment(defaultWidth = '') {
    return {
      id: uid('seg'),
      length_expr: '',
      width: defaultWidth ? String(defaultWidth) : '',
      label: ''
    };
  }

  function createEmptyLine(defaultWidth = '') {
    return {
      id: uid('line'),
      part: 'Seating',
      custom_part: '',
      design: '',
      rate: '',
      unit: 'inches_ft',
      measurement_pending: false,
      segments: [createEmptySegment(defaultWidth)]
    };
  }

  function getAllUsedWidths() {
    const widths = new Set();
    for (const line of formState.lines) {
      for (const seg of line?.segments || []) {
        const w = String(seg?.width || '').trim();
        if (w && !isNaN(parseFloat(w))) widths.add(w);
      }
    }
    return Array.from(widths);
  }

  function getLastUsedWidth(line) {
    if (line && Array.isArray(line.segments) && line.segments.length > 0) {
      for (let i = line.segments.length - 1; i >= 0; i--) {
        const w = String(line.segments[i]?.width || '').trim();
        if (w) return w;
      }
    }
    const all = getAllUsedWidths();
    return all.length > 0 ? all[all.length - 1] : '';
  }

  function openNewOrder() {
    formState = {
      id: null,
      lines: [createEmptyLine('')],
      shape: { template: 'None', unit: 'in', sides: {} },
      special_cuts: [],
      sketch_photo: null
    };

    safeEl('orderFormTitle').textContent = 'New Order';
    safeEl('editOrderId').value = '';
    safeEl('ordNo').value = getNextOrderNo();
    safeEl('ordCustomer').value = '';
    safeEl('ordPhone').value = '';
    safeEl('ordPromisedDate').value = '';
    safeEl('ordAddress').value = '';
    safeEl('ordPieces').value = '';
    safeEl('ordGeneralNote').value = '';
    safeEl('ordImportantNote').value = '';
    safeEl('ordImportantPriority').value = 'Normal';
    safeEl('ordAdvance').value = '0';
    safeEl('shapeTemplate').value = 'None';
    safeEl('shapeUnit').value = 'in';
    safeEl('sketchPhotoPreviewWrap')?.classList.add('hidden');

    renderOrderFormLines();
    onShapeTemplateChange();
    renderSpecialCutsForm();
    recalcOrderTotals();
    switchTab('orderForm');
  }

  function openEditOrder(orderId) {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) {
      showAlert('Order not found', 'error');
      return;
    }

    formState = {
      id: ord.id,
      lines: JSON.parse(JSON.stringify(ord.lines || [createEmptyLine('')])),
      shape: ord.shape_data
        ? JSON.parse(JSON.stringify(ord.shape_data))
        : { template: 'None', unit: 'in', sides: {} },
      special_cuts: JSON.parse(JSON.stringify(ord.special_cuts || [])),
      sketch_photo: ord.sketch_photo || null
    };

    safeEl('orderFormTitle').textContent = `Edit Order ${ord.order_no}`;
    safeEl('editOrderId').value = ord.id;
    safeEl('ordNo').value = ord.order_no || '';
    safeEl('ordCustomer').value = ord.customer || '';
    safeEl('ordPhone').value = ord.phone || '';
    safeEl('ordPromisedDate').value = ord.promised_date || '';
    safeEl('ordAddress').value = ord.address || '';
    safeEl('ordPieces').value = ord.pieces ?? '';
    safeEl('ordGeneralNote').value = ord.general_note || ord.note || '';
    safeEl('ordImportantNote').value = ord.important_note || '';
    safeEl('ordImportantPriority').value = ord.important_note_priority || 'Normal';
    safeEl('ordAdvance').value = ord.advance ?? 0;

    safeEl('shapeTemplate').value = formState.shape.template || 'None';
    safeEl('shapeUnit').value = formState.shape.unit || 'in';

    if (formState.sketch_photo) {
      safeEl('sketchPhotoPreview').src = formState.sketch_photo;
      safeEl('sketchPhotoPreviewWrap')?.classList.remove('hidden');
    } else {
      safeEl('sketchPhotoPreviewWrap')?.classList.add('hidden');
    }

    renderOrderFormLines();
    onShapeTemplateChange();
    renderSpecialCutsForm();
    recalcOrderTotals();
    switchTab('orderForm');
  }

  function addOrderLine() {
    const lastW = getLastUsedWidth();
    formState.lines.push(createEmptyLine(lastW));
    renderOrderFormLines();
    recalcOrderTotals();
  }

  function removeOrderLine(lineIdx) {
    if (formState.lines.length <= 1) {
      showAlert('An order must have at least 1 line.', 'error');
      return;
    }
    formState.lines.splice(lineIdx, 1);
    renderOrderFormLines();
    recalcOrderTotals();
  }

  function addSegment(lineIdx) {
    const line = formState.lines[lineIdx];
    if (!line) return;
    const prevWidth = getLastUsedWidth(line);
    line.segments.push(createEmptySegment(prevWidth));
    renderOrderFormLines();
    recalcOrderTotals();
  }

  function removeSegment(lineIdx, segIdx) {
    const line = formState.lines[lineIdx];
    if (!line || line.segments.length <= 1) return;
    line.segments.splice(segIdx, 1);
    renderOrderFormLines();
    recalcOrderTotals();
  }

  function updateLineField(lineIdx, field, val) {
    const line = formState.lines[lineIdx];
    if (!line) return;
    line[field] = val;
    if (field === 'part' || field === 'unit' || field === 'measurement_pending') {
      renderOrderFormLines();
    }
    recalcOrderTotals();
  }

  function updateSegmentField(lineIdx, segIdx, field, val) {
    const line = formState.lines[lineIdx];
    if (!line || !line.segments[segIdx]) return;
    line.segments[segIdx][field] = val;
    renderWidthChips();
    recalcOrderTotals();
  }

  function applyWidthChipToLine(lineIdx, widthVal) {
    const line = formState.lines[lineIdx];
    if (!line || !Array.isArray(line.segments) || line.segments.length === 0) return;
    // Apply to last segment or any segment without width
    let applied = false;
    for (const seg of line.segments) {
      if (!String(seg.width || '').trim()) {
        seg.width = String(widthVal);
        applied = true;
      }
    }
    if (!applied) {
      line.segments[line.segments.length - 1].width = String(widthVal);
    }
    renderOrderFormLines();
    recalcOrderTotals();
  }

  function renderWidthChips() {
    const widths = getAllUsedWidths();
    const bar = safeEl('usedWidthsBar');
    const wrap = safeEl('usedWidthsChips');
    if (!bar || !wrap) return;

    if (widths.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    wrap.innerHTML = widths
      .map(
        w =>
          `<button type="button" class="width-chip" onclick="App.applyWidthChipToLine(${
            formState.lines.length - 1
          }, '${esc(w)}')">${esc(w)}"</button>`
      )
      .join('');
  }

  function renderOrderFormLines() {
    const container = safeEl('orderLinesContainer');
    if (!container) return;

    const usedWidths = getAllUsedWidths();

    container.innerHTML = formState.lines
      .map((line, lIdx) => {
        const calc = calculateLine(line);
        const isOther = line.part === 'Other';
        const isPending = Boolean(line.measurement_pending);

        const widthChipsHtml =
          usedWidths.length > 0
            ? `<div class="chips-wrap" style="margin-top:4px;">
                <span class="muted-sm">Quick width:</span>
                ${usedWidths
                  .map(
                    w =>
                      `<button type="button" class="width-chip" onclick="App.applyWidthChipToLine(${lIdx}, '${esc(
                        w
                      )}')">${esc(w)}"</button>`
                  )
                  .join('')}
               </div>`
            : '';

        const segmentsHtml = (line.segments || [])
          .map(
            (seg, sIdx) => `
          <div class="segment-row">
            <input type="text" class="input" placeholder="Length (e.g. 102+102+36 or 24x4)"
              value="${esc(seg.length_expr)}"
              oninput="App.updateSegmentField(${lIdx}, ${sIdx}, 'length_expr', this.value)" />
            <input type="number" class="input" placeholder="Width in (optional)" step="any"
              value="${esc(seg.width)}"
              oninput="App.updateSegmentField(${lIdx}, ${sIdx}, 'width', this.value)" />
            <input type="text" class="input" placeholder="Label (opt, e.g. Left)"
              value="${esc(seg.label)}"
              oninput="App.updateSegmentField(${lIdx}, ${sIdx}, 'label', this.value)" />
            <button type="button" class="btn btn-xs btn-danger-outline" onclick="App.removeSegment(${lIdx}, ${sIdx})" title="Remove segment">&times;</button>
          </div>
        `
          )
          .join('');

        return `
        <div class="line-card ${isPending ? 'pending-meas' : ''}" id="lineCard_${lIdx}">
          <div class="line-header">
            <strong>Line #${lIdx + 1}</strong>
            <div class="btn-row">
              <label style="display:inline-flex;align-items:center;gap:5px;font-weight:700;color:#b91c1c;cursor:pointer;">
                <input type="checkbox" ${isPending ? 'checked' : ''}
                  onchange="App.updateLineField(${lIdx}, 'measurement_pending', this.checked)" />
                Measurement pending
              </label>
              <button type="button" class="btn btn-xs btn-danger-outline" onclick="App.removeOrderLine(${lIdx})">Remove Line</button>
            </div>
          </div>

          <div class="form-grid-4">
            <div class="form-group">
              <label>Part</label>
              <select class="input" onchange="App.updateLineField(${lIdx}, 'part', this.value)">
                <option value="Seating" ${line.part === 'Seating' ? 'selected' : ''}>Seating</option>
                <option value="Back" ${line.part === 'Back' ? 'selected' : ''}>Back</option>
                <option value="Handle" ${line.part === 'Handle' ? 'selected' : ''}>Handle</option>
                <option value="Other" ${line.part === 'Other' ? 'selected' : ''}>Other (Custom name)</option>
              </select>
              ${
                isOther
                  ? `<input type="text" class="input" style="margin-top:6px;" placeholder="Enter part name..."
                      value="${esc(line.custom_part)}"
                      oninput="App.updateLineField(${lIdx}, 'custom_part', this.value)" />`
                  : ''
              }
            </div>

            <div class="form-group">
              <label>Design Name</label>
              <input type="text" class="input" placeholder="e.g. Ronaldo Cream"
                value="${esc(line.design)}"
                oninput="App.updateLineField(${lIdx}, 'design', this.value)" />
            </div>

            <div class="form-group">
              <label>Rate (Rs)</label>
              <input type="number" class="input" min="0" step="any" placeholder="e.g. 275"
                value="${esc(line.rate)}"
                oninput="App.updateLineField(${lIdx}, 'rate', this.value)" />
            </div>

            <div class="form-group">
              <label>Unit</label>
              <select class="input" onchange="App.updateLineField(${lIdx}, 'unit', this.value)">
                <option value="inches_ft" ${line.unit !== 'pcs' ? 'selected' : ''}>Inches → ft (.25 ceil)</option>
                <option value="pcs" ${line.unit === 'pcs' ? 'selected' : ''}>Pcs (pcs × rate)</option>
              </select>
            </div>
          </div>

          <div class="segments-wrap">
            <label style="font-size:12px;font-weight:700;">Segments (Length in inches | Width optional | Label optional)</label>
            ${segmentsHtml}
          </div>

          <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <button type="button" class="btn btn-sm btn-outline" onclick="App.addSegment(${lIdx})">+ Add segment</button>
            ${widthChipsHtml}
          </div>

          <div class="line-live-calc" id="lineLiveCalc_${lIdx}">
            <span>${esc(getLinePartName(line))} — ${esc(line.design || 'No design')}: ${esc(calc.segJoined)}</span>
            <span>${esc(calc.calcDisplay)}</span>
          </div>
        </div>
      `;
      })
      .join('');

    renderWidthChips();
  }

  function recalcOrderTotals() {
    let orderTotal = 0;
    formState.lines.forEach((line, idx) => {
      const calc = calculateLine(line);
      orderTotal += calc.amount;
      const liveEl = safeEl(`lineLiveCalc_${idx}`);
      if (liveEl) {
        liveEl.innerHTML = `
          <span>${esc(getLinePartName(line))} — ${esc(line.design || 'No design')}: ${esc(calc.segJoined)}</span>
          <span>${esc(calc.calcDisplay)}</span>
        `;
      }
    });

    const advance = Math.floor(parseFloat(safeEl('ordAdvance')?.value) || 0);
    const balance = orderTotal - advance;

    const totalEl = safeEl('formTotalDisplay');
    const balEl = safeEl('formBalanceDisplay');
    if (totalEl) totalEl.textContent = `₹${formatRs(orderTotal)}`;
    if (balEl) balEl.textContent = `₹${formatRs(balance)}`;

    return { orderTotal, advance, balance };
  }

  // ==========================================================================
  // FEATURE B: SHAPE PICKER, AUTO SVG OUTLINE & SPECIAL CUTS
  // ==========================================================================
  const SHAPE_SIDE_DEFINITIONS = {
    None: [],
    Straight: [
      { key: 'length', label: 'Front Length', defaultVal: '72' },
      { key: 'depth', label: 'Depth', defaultVal: '30' }
    ],
    'L-shape': [
      { key: 'main_length', label: 'Main Back Length (A)', defaultVal: '102' },
      { key: 'left_return', label: 'L Return Length (B)', defaultVal: '78' },
      { key: 'depth', label: 'Seat Depth (C)', defaultVal: '36' }
    ],
    'L-shape with a step': [
      { key: 'main_length', label: 'Main Back Length (A)', defaultVal: '102' },
      { key: 'left_return', label: 'L Return Length (B)', defaultVal: '84' },
      { key: 'depth', label: 'Seat Depth (C)', defaultVal: '36' },
      { key: 'step_w', label: 'Step Cut Width', defaultVal: '12' },
      { key: 'step_d', label: 'Step Cut Depth', defaultVal: '8' }
    ],
    'U-shape': [
      { key: 'left_len', label: 'Left Arm Length (A)', defaultVal: '78' },
      { key: 'center_len', label: 'Center Back Length (B)', defaultVal: '108' },
      { key: 'right_len', label: 'Right Arm Length (C)', defaultVal: '78' },
      { key: 'depth', label: 'Seat Depth', defaultVal: '36' }
    ],
    Corner: [
      { key: 'side_a', label: 'Left Side (A)', defaultVal: '90' },
      { key: 'side_b', label: 'Right Side (B)', defaultVal: '90' },
      { key: 'corner_w', label: 'Corner Wedge', defaultVal: '38' }
    ],
    'Curved corner': [
      { key: 'side_a', label: 'Left Side (A)', defaultVal: '96' },
      { key: 'side_b', label: 'Right Side (B)', defaultVal: '96' },
      { key: 'radius', label: 'Curve Radius (R)', defaultVal: '36' }
    ]
  };

  function onShapeTemplateChange() {
    const tpl = safeEl('shapeTemplate')?.value || 'None';
    const unit = safeEl('shapeUnit')?.value || 'in';
    formState.shape.template = tpl;
    formState.shape.unit = unit;
    if (!formState.shape.sides) formState.shape.sides = {};

    const defs = SHAPE_SIDE_DEFINITIONS[tpl] || [];
    for (const d of defs) {
      if (formState.shape.sides[d.key] === undefined) {
        formState.shape.sides[d.key] = d.defaultVal;
      }
    }

    const inputsWrap = safeEl('shapeSidesInputs');
    if (inputsWrap) {
      if (defs.length === 0) {
        inputsWrap.innerHTML = `<p class="muted-sm">No shape outline selected.</p>`;
      } else {
        inputsWrap.innerHTML = `<div class="form-grid-2">
          ${defs
            .map(
              d => `
            <div class="form-group">
              <label>${esc(d.label)}</label>
              <input type="text" class="input" value="${esc(formState.shape.sides[d.key] || '')}"
                oninput="App.updateShapeSide('${d.key}', this.value)" />
            </div>
          `
            )
            .join('')}
        </div>`;
      }
    }

    renderShapeSVG();
  }

  function updateShapeSide(key, val) {
    formState.shape.sides[key] = val;
    renderShapeSVG();
  }

  function generateShapeSVGMarkup(shapeObj) {
    const tpl = shapeObj?.template || 'None';
    if (tpl === 'None') return '';
    const unit = shapeObj?.unit === 'ft' ? 'ft' : '"';
    const s = shapeObj?.sides || {};
    const lbl = k => `${esc(s[k] || '0')}${unit}`;

    let pathAndLabels = '';

    if (tpl === 'Straight') {
      pathAndLabels = `
        <rect x="40" y="55" width="220" height="70" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="150" y="45" text-anchor="middle" font-size="12" font-weight="bold">Length: ${lbl('length')}</text>
        <text x="270" y="95" text-anchor="start" font-size="12" font-weight="bold">${lbl('depth')}</text>
      `;
    } else if (tpl === 'L-shape') {
      pathAndLabels = `
        <polygon points="40,35 250,35 250,90 105,90 105,155 40,155" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('main_length')}</text>
        <text x="12" y="100" text-anchor="start" font-size="12" font-weight="bold">B: ${lbl('left_return')}</text>
        <text x="255" y="68" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('depth')}</text>
      `;
    } else if (tpl === 'L-shape with a step') {
      pathAndLabels = `
        <polygon points="40,35 250,35 250,90 105,90 105,135 80,135 80,158 40,158" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('main_length')}</text>
        <text x="10" y="98" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('left_return')}</text>
        <text x="254" y="66" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('depth')}</text>
        <text x="115" y="150" text-anchor="start" font-size="11" font-weight="bold">Step: ${lbl('step_w')}×${lbl('step_d')}</text>
      `;
    } else if (tpl === 'U-shape') {
      pathAndLabels = `
        <polygon points="35,30 265,30 265,155 210,155 210,80 90,80 90,155 35,155" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="150" y="22" text-anchor="middle" font-size="12" font-weight="bold">B: ${lbl('center_len')}</text>
        <text x="8" y="95" text-anchor="start" font-size="11" font-weight="bold">A: ${lbl('left_len')}</text>
        <text x="270" y="95" text-anchor="start" font-size="11" font-weight="bold">C: ${lbl('right_len')}</text>
        <text x="150" y="100" text-anchor="middle" font-size="11">Depth: ${lbl('depth')}</text>
      `;
    } else if (tpl === 'Corner') {
      pathAndLabels = `
        <polygon points="40,35 245,35 245,88 115,88 90,115 90,160 40,160" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="145" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('side_a')}</text>
        <text x="10" y="105" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('side_b')}</text>
        <text x="145" y="115" text-anchor="start" font-size="11" font-weight="bold">Corner: ${lbl('corner_w')}</text>
      `;
    } else if (tpl === 'Curved corner') {
      pathAndLabels = `
        <path d="M 40,160 L 40,85 Q 40,35 95,35 L 250,35 L 250,88 L 110,88 Q 92,88 92,108 L 92,160 Z" fill="#f8fafc" stroke="#000" stroke-width="2.5"/>
        <text x="155" y="25" text-anchor="middle" font-size="12" font-weight="bold">A: ${lbl('side_a')}</text>
        <text x="10" y="125" text-anchor="start" font-size="11" font-weight="bold">B: ${lbl('side_b')}</text>
        <text x="145" y="115" text-anchor="start" font-size="11" font-weight="bold">Curve R: ${lbl('radius')}</text>
      `;
    }

    return `
      <svg viewBox="0 0 330 180" xmlns="http://www.w3.org/2000/svg">
        <text x="165" y="175" text-anchor="middle" font-size="11" fill="#333">Shape: ${esc(tpl)}</text>
        ${pathAndLabels}
      </svg>
    `;
  }

  function renderShapeSVG() {
    formState.shape.unit = safeEl('shapeUnit')?.value || 'in';
    const wrap = safeEl('shapeSvgContainer');
    if (!wrap) return;
    const svg = generateShapeSVGMarkup(formState.shape);
    wrap.innerHTML = svg || `<div class="muted-sm" style="padding:24px;">Select a shape template to auto-draw outline</div>`;
  }

  function addSpecialCut() {
    formState.special_cuts.push({
      id: uid('sc'),
      cut_type: 'Step cut',
      line_ref: 'Line #1',
      size: '',
      note: ''
    });
    renderSpecialCutsForm();
  }

  function removeSpecialCut(idx) {
    formState.special_cuts.splice(idx, 1);
    renderSpecialCutsForm();
  }

  function updateSpecialCut(idx, field, val) {
    if (!formState.special_cuts[idx]) return;
    formState.special_cuts[idx][field] = val;
  }

  function renderSpecialCutsForm() {
    const wrap = safeEl('specialCutsContainer');
    if (!wrap) return;

    if (formState.special_cuts.length === 0) {
      wrap.innerHTML = `<p class="muted-sm">No special cuts added.</p>`;
      return;
    }

    const cutTypes = [
      'Step cut',
      'Notch around leg/pillar',
      'Curved corner',
      'Recliner',
      'Chaise',
      'Round arm',
      'Other'
    ];

    const lineOptions = formState.lines.map((l, i) => `Line #${i + 1} (${getLinePartName(l)})`);

    wrap.innerHTML = formState.special_cuts
      .map(
        (sc, idx) => `
      <div class="special-cut-row">
        <select class="input" onchange="App.updateSpecialCut(${idx}, 'cut_type', this.value)">
          ${cutTypes
            .map(t => `<option value="${esc(t)}" ${sc.cut_type === t ? 'selected' : ''}>${esc(t)}</option>`)
            .join('')}
        </select>
        <input type="text" class="input" list="lineRefsList" placeholder="Line / Segment"
          value="${esc(sc.line_ref)}"
          oninput="App.updateSpecialCut(${idx}, 'line_ref', this.value)" />
        <input type="text" class="input" placeholder="Size (e.g. 6x4 in)"
          value="${esc(sc.size)}"
          oninput="App.updateSpecialCut(${idx}, 'size', this.value)" />
        <input type="text" class="input" placeholder="Cut instruction / note"
          value="${esc(sc.note)}"
          oninput="App.updateSpecialCut(${idx}, 'note', this.value)" />
        <button type="button" class="btn btn-xs btn-danger-outline" onclick="App.removeSpecialCut(${idx})">&times;</button>
      </div>
    `
      )
      .join('') +
      `<datalist id="lineRefsList">${lineOptions.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
  }

  function handleSketchPhotoUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      formState.sketch_photo = e.target?.result || null;
      if (formState.sketch_photo) {
        safeEl('sketchPhotoPreview').src = formState.sketch_photo;
        safeEl('sketchPhotoPreviewWrap')?.classList.remove('hidden');
      }
    };
    reader.readAsDataURL(file);
  }

  function removeSketchPhoto() {
    formState.sketch_photo = null;
    if (safeEl('sketchPhotoInput')) safeEl('sketchPhotoInput').value = '';
    safeEl('sketchPhotoPreviewWrap')?.classList.add('hidden');
  }

  // ==========================================================================
  // REVIEW & CONFIRM POPUP + SAVING ORDER (NEVER CRASHES)
  // ==========================================================================
  function collectOrderFromForm(statusOverride) {
    const { orderTotal, advance, balance } = recalcOrderTotals();
    const existingId = safeEl('editOrderId')?.value || formState.id;
    const existingOrd = existingId ? state.orders.find(o => safeId(o) === existingId) : null;

    const autoPieces = formState.lines.reduce((acc, l) => acc + (l?.segments?.length || 1), 0);
    const manualPieces = parseInt(safeEl('ordPieces')?.value, 10);

    const orderObj = normalizeOrder({
      ...(existingOrd || {}),
      id: existingId || uid('ord'),
      order_no: (safeEl('ordNo')?.value || '').trim() || getNextOrderNo(),
      customer: (safeEl('ordCustomer')?.value || '').trim() || 'Customer',
      phone: (safeEl('ordPhone')?.value || '').trim(),
      promised_date: safeEl('ordPromisedDate')?.value || '',
      address: (safeEl('ordAddress')?.value || '').trim(),
      pieces: !isNaN(manualPieces) && manualPieces > 0 ? manualPieces : autoPieces,
      general_note: (safeEl('ordGeneralNote')?.value || '').trim(),
      important_note: (safeEl('ordImportantNote')?.value || '').trim(),
      important_note_priority: safeEl('ordImportantPriority')?.value || 'Normal',
      lines: JSON.parse(JSON.stringify(formState.lines)),
      shape_data: JSON.parse(JSON.stringify(formState.shape)),
      special_cuts: JSON.parse(JSON.stringify(formState.special_cuts)),
      sketch_photo: formState.sketch_photo,
      total: orderTotal,
      advance,
      balance,
      status: statusOverride || existingOrd?.status || 'Pending',
      created_at: existingOrd?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return orderObj;
  }

  function openReviewConfirmModal() {
    const customer = (safeEl('ordCustomer')?.value || '').trim();
    if (!customer) {
      showAlert('Please enter Customer Name before confirming.', 'error');
      safeEl('ordCustomer')?.focus();
      return;
    }

    const previewOrd = collectOrderFromForm('Confirmed');
    const body = safeEl('reviewConfirmBody');
    if (!body) return;

    const linesHtml = previewOrd.lines
      .map(l => {
        const c = calculateLine(l);
        return `<div class="order-line-bullet ${l.measurement_pending ? 'highlight-pending' : ''}">
          <strong>${esc(getLinePartName(l))} - ${esc(l.design || 'Standard')}</strong>: ${esc(c.segJoined)}
          <div class="muted-sm">${esc(c.calcDisplay)} ${
          l.measurement_pending ? '⚠️ MEASUREMENT PENDING' : ''
        }</div>
        </div>`;
      })
      .join('');

    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <strong>Order No:</strong> ${esc(previewOrd.order_no)} |
        <strong>Customer:</strong> ${esc(previewOrd.customer)} (${esc(previewOrd.phone || 'No phone')})
      </div>
      <div class="order-lines-summary">${linesHtml}</div>
      <div style="display:flex;justify-content:space-between;font-size:15px;margin-top:10px;">
        <span><strong>Total:</strong> ₹${formatRs(previewOrd.total)}</span>
        <span><strong>Advance:</strong> ₹${formatRs(previewOrd.advance)}</span>
        <span><strong>Balance:</strong> ₹${formatRs(previewOrd.balance)}</span>
      </div>
      ${
        previewOrd.advance === 0
          ? `<div class="warn-banner" style="margin-top:10px;">ℹ️ Advance is Rs 0 — an Important Note will be auto-created on confirm.</div>`
          : ''
      }
    `;

    safeEl('reviewConfirmModal')?.classList.remove('hidden');
  }

  function closeReviewConfirmModal() {
    safeEl('reviewConfirmModal')?.classList.add('hidden');
  }

  async function saveOrderDirect(statusToSet = 'Pending') {
    const ord = collectOrderFromForm(statusToSet);
    await persistOrderAndNotes(ord);
    showAlert(`Order ${ord.order_no} saved as ${ord.status}`, 'success');
    switchTab('dashboard');
  }

  async function confirmOrderFlow(mode) {
    closeReviewConfirmModal();
    const targetStatus = mode === 'pending' ? 'Pending' : 'Confirmed';
    const ord = collectOrderFromForm(targetStatus);
    if (mode !== 'pending') {
      ord.sticker_printed = true;
      ord.sticker_printed_at = new Date().toISOString();
    }

    await persistOrderAndNotes(ord);
    switchTab('dashboard');

    if (mode === 'sticker_wa') {
      openStickerModal(ord.id);
      openWaPreviewModal(ord.id, 'receipt');
    } else if (mode === 'sticker_only') {
      openStickerModal(ord.id);
    } else {
      showAlert(`Order ${ord.order_no} saved as Pending.`, 'success');
    }
  }

  async function persistOrderAndNotes(ord) {
    if (!ord || !safeId(ord)) return;

    const idx = state.orders.findIndex(o => safeId(o) === ord.id);
    if (idx >= 0) {
      state.orders[idx] = ord;
    } else {
      state.orders.unshift(ord);
    }

    // FEATURE F: Important Notes creation (Manual + Auto rules)
    // 1. Manual important note on order form
    if (ord.important_note) {
      createNoteIfNotDuplicate({
        order_id: ord.id,
        order_no: ord.order_no,
        customer_name: ord.customer,
        note: ord.important_note,
        priority: ord.important_note_priority || 'Normal',
        written_by: currentUser?.role || 'Sales',
        is_auto: false,
        auto_type: 'manual_order_note'
      });
    }

    // 2. Auto-note when confirmed with advance = 0
    if (ord.status === 'Confirmed' && (Number(ord.advance) || 0) === 0) {
      createNoteIfNotDuplicate({
        order_id: ord.id,
        order_no: ord.order_no,
        customer_name: ord.customer,
        note: `Order confirmed with Advance = Rs 0 (Total Rs ${formatRs(ord.total)})`,
        priority: 'Urgent',
        written_by: 'System (Auto)',
        is_auto: true,
        auto_type: 'zero_advance'
      });
    }

    // 3. Auto-note when any line is marked Measurement pending
    const pendingLines = (ord.lines || []).filter(l => l && l.measurement_pending);
    if (pendingLines.length > 0) {
      const partsList = pendingLines.map(l => `${getLinePartName(l)} (${l.design || 'No design'})`).join(', ');
      createNoteIfNotDuplicate({
        order_id: ord.id,
        order_no: ord.order_no,
        customer_name: ord.customer,
        note: `Measurement pending on: ${partsList}`,
        priority: 'Urgent',
        written_by: 'System (Auto)',
        is_auto: true,
        auto_type: 'measurement_pending'
      });
    }

    await saveOrderToServer(ord);
    renderAll();
  }

  // ==========================================================================
  // FEATURE F: IMPORTANT NOTES BOARD LOGIC
  // ==========================================================================
  function createNoteIfNotDuplicate(noteObj) {
    const exists = state.notes.some(
      n =>
        !n.is_done &&
        n.order_id === noteObj.order_id &&
        ((noteObj.is_auto && n.auto_type === noteObj.auto_type) || n.note === noteObj.note)
    );
    if (exists) return;

    const newNote = {
      id: uid('note'),
      order_id: noteObj.order_id || null,
      order_no: noteObj.order_no || '',
      customer_name: noteObj.customer_name || '',
      note: noteObj.note,
      priority: noteObj.priority || 'Normal',
      written_by: noteObj.written_by || currentUser?.role || 'Sales',
      is_auto: Boolean(noteObj.is_auto),
      auto_type: noteObj.auto_type || null,
      is_done: false,
      done_by: null,
      done_at: null,
      created_at: new Date().toISOString()
    };

    state.notes.unshift(newNote);
    saveLocalState();
    if (supabaseClient) {
      supabaseClient.from('important_notes').upsert(newNote).then(() => {});
    }
  }

  function markNoteDone(noteId, event) {
    if (event) event.stopPropagation();
    const note = state.notes.find(n => n && n.id === noteId);
    if (!note) return;
    note.is_done = true;
    note.done_by = currentUser?.role || 'Admin';
    note.done_at = new Date().toISOString();
    saveLocalState();
    if (supabaseClient) {
      supabaseClient.from('important_notes').upsert(note).then(() => {});
    }
    renderNotesBoard();
  }

  function toggleNotesHistory(showDone) {
    showDoneNotes = Boolean(showDone);
    renderNotesBoard();
  }

  function scrollToNotesBoard() {
    switchTab('dashboard');
    safeEl('importantNotesBoard')?.scrollIntoView({ behavior: 'smooth' });
  }

  function openQuickNoteModal() {
    const sel = safeEl('qnOrderSelect');
    if (sel) {
      const activeOrders = state.orders.filter(o => !o.is_archived && !o.is_deleted);
      sel.innerHTML =
        `<option value="">-- General Shop Note (No Order) --</option>` +
        activeOrders
          .map(o => `<option value="${esc(o.id)}">${esc(o.order_no)} - ${esc(o.customer)}</option>`)
          .join('');
    }
    safeEl('qnText').value = '';
    safeEl('qnPriority').value = 'Normal';
    safeEl('quickNoteModal')?.classList.remove('hidden');
  }

  function closeQuickNoteModal() {
    safeEl('quickNoteModal')?.classList.add('hidden');
  }

  function saveQuickNote() {
    const txt = (safeEl('qnText')?.value || '').trim();
    if (!txt) {
      showAlert('Please write a note.', 'error');
      return;
    }
    const ordId = safeEl('qnOrderSelect')?.value || '';
    const ord = ordId ? state.orders.find(o => safeId(o) === ordId) : null;

    createNoteIfNotDuplicate({
      order_id: ord ? ord.id : null,
      order_no: ord ? ord.order_no : 'SHOP',
      customer_name: ord ? ord.customer : '',
      note: txt,
      priority: safeEl('qnPriority')?.value || 'Normal',
      written_by: currentUser?.role || 'Admin',
      is_auto: false
    });

    closeQuickNoteModal();
    renderNotesBoard();
  }

  function renderNotesBoard() {
    const openNotes = state.notes.filter(n => n && !n.is_done);
    const doneNotes = state.notes.filter(n => n && n.is_done);

    const badge = safeEl('openNotesBadge');
    const topBadge = safeEl('notesTopBadge');
    if (badge) badge.textContent = String(openNotes.length);
    if (topBadge) {
      topBadge.textContent = String(openNotes.length);
      topBadge.classList.toggle('hidden', openNotes.length === 0);
    }

    const listEl = safeEl('importantNotesList');
    if (!listEl) return;

    const listToShow = showDoneNotes ? doneNotes : openNotes;
    if (listToShow.length === 0) {
      listEl.innerHTML = `<div class="muted-sm">${
        showDoneNotes ? 'No completed notes in history.' : 'No open important notes right now.'
      }</div>`;
      return;
    }

    listEl.innerHTML = listToShow
      .map(n => {
        const isUrgent = n.priority === 'Urgent';
        const timeStr = n.created_at ? new Date(n.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '';
        return `
        <div class="note-item ${isUrgent ? 'urgent' : ''}" onclick="${
          n.order_id ? `App.openEditOrder('${esc(n.order_id)}')` : ''
        }">
          <div>
            <div>
              <strong>${esc(n.order_no || 'Shop Note')}</strong>
              ${n.customer_name ? `(${esc(n.customer_name)})` : ''}
              <span class="meas-pending-pill" style="${
                isUrgent ? '' : 'background:#e2e8f0;color:#1e293b;border-color:#94a3b8;'
              }">${esc(n.priority)}</span>
            </div>
            <div style="margin:3px 0;font-weight:600;">${esc(n.note)}</div>
            <div class="note-meta">By ${esc(n.written_by)} • ${esc(timeStr)} ${
          n.is_done ? `• Done by ${esc(n.done_by)}` : ''
        }</div>
          </div>
          <div>
            ${
              !n.is_done
                ? `<button type="button" class="btn btn-xs btn-success" onclick="App.markNoteDone('${esc(
                    n.id
                  )}', event)">✓ Mark done</button>`
                : ''
            }
          </div>
        </div>
      `;
      })
      .join('');
  }

  // ==========================================================================
  // STICKER PRINTING (LINES + HIGHLIGHT PENDING + SVG SHAPE, NO SKETCH PHOTO)
  // ==========================================================================
  function openStickerModal(orderId) {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;

    ord.sticker_printed = true;
    ord.sticker_printed_at = new Date().toISOString();
    saveOrderToServer(ord);

    const svgHtml = generateShapeSVGMarkup(ord.shape_data);
    const linesHtml = (ord.lines || [])
      .map(l => {
        const text = formatLineForWorkScreen(l);
        return `<div class="sticker-line-item ${l.measurement_pending ? 'pending' : ''}">${esc(text)}</div>`;
      })
      .join('');

    const specialCutsHtml =
      Array.isArray(ord.special_cuts) && ord.special_cuts.length > 0
        ? `<div style="border:1px solid #000;padding:6px;margin-top:8px;font-size:12px;">
            <strong>SPECIAL CUTS:</strong>
            ${ord.special_cuts
              .map(sc => `<div>• ${esc(sc.cut_type)} (${esc(sc.line_ref)}): ${esc(sc.size)} - ${esc(sc.note)}</div>`)
              .join('')}
           </div>`
        : '';

    const sheet = safeEl('stickerPrintContent');
    if (sheet) {
      sheet.innerHTML = `
        <div class="sticker-header">
          <h2>${esc(state.settings.shop_name || 'Shree Gayatri Furnishing Hub')}</h2>
          <div>Order Sticker • Ph: ${esc(state.settings.shop_phone || '')}</div>
        </div>
        <div class="sticker-meta-grid">
          <div><strong>Order No:</strong> ${esc(ord.order_no)}</div>
          <div><strong>Pieces:</strong> ${esc(ord.pieces || 1)} Pcs</div>
          <div><strong>Customer:</strong> ${esc(ord.customer)}</div>
          <div><strong>Promised:</strong> ${esc(ord.promised_date || '-')}</div>
        </div>
        <div>
          <strong>Order Lines:</strong>
          ${linesHtml}
        </div>
        ${specialCutsHtml}
        ${
          svgHtml
            ? `<div style="margin-top:8px;text-align:center;border-top:1px solid #000;padding-top:6px;">${svgHtml}</div>`
            : ''
        }
        ${ord.general_note ? `<div style="margin-top:6px;font-size:12px;"><strong>Note:</strong> ${esc(ord.general_note)}</div>` : ''}
      `;
    }

    safeEl('stickerModal')?.classList.remove('hidden');
  }

  function closeStickerModal() {
    safeEl('stickerModal')?.classList.add('hidden');
  }

  function printStickerNow() {
    window.print();
  }

  // ==========================================================================
  // FEATURE C: WHATSAPP TEMPLATES & PREVIEW
  // ==========================================================================
  function buildWhatsAppMessage(ord, tplKey) {
    if (!ord) return '';
    const tplObj = state.settings.templates?.[tplKey] || getDefaultTemplates()[tplKey] || getDefaultTemplates().receipt;
    const rawTpl = tplObj.text || '';

    const linesFormatted = (ord.lines || []).map(l => `• ${formatLineForReceipt(l)}`).join('\n');

    return rawTpl
      .replace(/\{customer\}/g, ord.customer || 'Customer')
      .replace(/\{order_no\}/g, ord.order_no || '')
      .replace(/\{lines\}/g, linesFormatted)
      .replace(/\{total\}/g, formatRs(ord.total))
      .replace(/\{advance\}/g, formatRs(ord.advance))
      .replace(/\{balance\}/g, formatRs(ord.balance))
      .replace(/\{promised_date\}/g, ord.promised_date || 'As discussed')
      .replace(/\{shop_phone\}/g, state.settings.shop_phone || '');
  }

  function openWaPreviewModal(orderId, defaultTpl = 'receipt') {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;
    activeWaOrder = ord;
    safeEl('waTemplateSelect').value = defaultTpl;
    safeEl('waPhoneInput').value = ord.phone || '';
    updateWaPreviewText();
    safeEl('waPreviewModal')?.classList.remove('hidden');
  }

  function updateWaPreviewText() {
    if (!activeWaOrder) return;
    const tplKey = safeEl('waTemplateSelect')?.value || 'receipt';
    safeEl('waPreviewTextarea').value = buildWhatsAppMessage(activeWaOrder, tplKey);
  }

  function closeWaPreviewModal() {
    safeEl('waPreviewModal')?.classList.add('hidden');
  }

  function copyWaPreviewText() {
    const txt = safeEl('waPreviewTextarea')?.value || '';
    navigator.clipboard?.writeText(txt);
    showAlert('Message copied to clipboard!', 'success');
  }

  function sendWaNow() {
    const rawPhone = (safeEl('waPhoneInput')?.value || '').replace(/\D/g, '');
    const phone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
    const msg = safeEl('waPreviewTextarea')?.value || '';
    const encoded = encodeURIComponent(msg);
    const url = phone ? `https://wa.me/${phone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
    window.open(url, '_blank', 'noopener');
  }

  // ==========================================================================
  // CUTTING & TAILOR WORKFLOW (YELLOW SPECIAL CUT BOX + MANDATORY ACK)
  // ==========================================================================
  function toggleSpecialCutAck(orderId, checked) {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;
    ord.special_cut_ack = Boolean(checked);
    ord.special_cut_ack_by = currentUser?.role || 'Cutting';
    ord.special_cut_ack_at = new Date().toISOString();
    saveOrderToServer(ord);
    renderAll();
  }

  function advanceOrderStatus(orderId, nextStatus) {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;

    const hasSpecialCuts = Array.isArray(ord.special_cuts) && ord.special_cuts.length > 0;
    if (nextStatus === 'Cutting OK' && hasSpecialCuts && !ord.special_cut_ack) {
      showAlert('Please tick "I have read the special cut" before marking Cutting OK.', 'error');
      return;
    }

    ord.status = nextStatus;
    ord.updated_at = new Date().toISOString();
    saveOrderToServer(ord);
    renderAll();
    showAlert(`Order ${ord.order_no} marked as ${nextStatus}`, 'success');
  }

  function renderSpecialCutYellowBox(ord, isCuttingScreen = false) {
    const hasCuts = Array.isArray(ord.special_cuts) && ord.special_cuts.length > 0;
    const hasSketch = Boolean(ord.sketch_photo);
    if (!hasCuts && !hasSketch) return '';

    const cutsListHtml = (ord.special_cuts || [])
      .map(
        sc =>
          `<div>• <strong>${esc(sc.cut_type)}</strong> [${esc(sc.line_ref)}]: <strong>${esc(
            sc.size
          )}</strong> — ${esc(sc.note)}</div>`
      )
      .join('');

    const sketchHtml = hasSketch
      ? `<div class="no-print-sketch" style="margin-top:8px;">
          <div><strong>📷 Attached Sketch Photo (Tap to enlarge):</strong></div>
          <img src="${esc(ord.sketch_photo)}" alt="Sketch" class="sketch-img-thumb" onclick="App.openImageModal(this.src)" />
         </div>`
      : '';

    const ackCheckboxHtml =
      isCuttingScreen && hasCuts
        ? `<label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-weight:800;cursor:pointer;">
            <input type="checkbox" ${ord.special_cut_ack ? 'checked' : ''}
              onchange="App.toggleSpecialCutAck('${esc(ord.id)}', this.checked)" />
            I have read the special cut
           </label>`
        : '';

    return `
      <div class="special-cut-alert-box">
        <h4>⚠️ SPECIAL CUT INSTRUCTIONS</h4>
        ${cutsListHtml}
        ${sketchHtml}
        ${ackCheckboxHtml}
      </div>
    `;
  }

  // ==========================================================================
  // FEATURE E: MOVE BACK / ARCHIVE / DELETE / PERMANENT DELETE (ADMIN ONLY)
  // ==========================================================================
  function openAdminActionModal(type, orderId) {
    if (currentUser?.role !== 'Admin') {
      showAlert('Admin permission required.', 'error');
      return;
    }
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;

    pendingAdminAction = { type, orderId: ord.id };
    safeEl('adminActionReason').value = '';
    safeEl('adminConfirmOrderNoInput').value = '';

    const warnEl = safeEl('adminActionWarning');
    const typeWrap = safeEl('adminTypeOrderNoWrap');
    warnEl?.classList.add('hidden');
    typeWrap?.classList.add('hidden');

    if (type === 'move_pending') {
      safeEl('adminActionTitle').textContent = `Move Order ${ord.order_no} Back to Pending`;
      const cuttingStarted = ['Cutting OK', 'Ready', 'Delivered'].includes(ord.status);
      if (ord.sticker_printed || cuttingStarted) {
        warnEl.textContent = `⚠️ WARNING: ${
          ord.sticker_printed ? 'Sticker has already been printed! ' : ''
        }${cuttingStarted ? `Order is already in "${ord.status}" status!` : ''}`;
        warnEl.classList.remove('hidden');
      }
    } else if (type === 'archive') {
      safeEl('adminActionTitle').textContent = `Archive Order ${ord.order_no}`;
    } else if (type === 'trash') {
      safeEl('adminActionTitle').textContent = `Move Order ${ord.order_no} to Trash (30 Days)`;
    } else if (type === 'permanent_delete') {
      safeEl('adminActionTitle').textContent = `Permanently Delete Order ${ord.order_no}`;
      warnEl.textContent = '⚠️ This will permanently erase this order and cannot be undone.';
      warnEl.classList.remove('hidden');
      safeEl('adminExpectedOrderNo').textContent = ord.order_no;
      typeWrap.classList.remove('hidden');
    }

    safeEl('adminActionModal')?.classList.remove('hidden');
  }

  function closeAdminActionModal() {
    pendingAdminAction = null;
    safeEl('adminActionModal')?.classList.add('hidden');
  }

  async function executeAdminAction() {
    if (!pendingAdminAction) return;
    const { type, orderId } = pendingAdminAction;
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;

    const reason = (safeEl('adminActionReason')?.value || '').trim();
    if (!reason) {
      showAlert('Reason is required for Admin actions.', 'error');
      return;
    }

    if (type === 'permanent_delete') {
      const typedNo = (safeEl('adminConfirmOrderNoInput')?.value || '').trim();
      if (typedNo !== ord.order_no) {
        showAlert(`Please type the exact order number (${ord.order_no}) to confirm permanent delete.`, 'error');
        return;
      }
    }

    const logEntry = {
      id: uid('log'),
      order_id: ord.id,
      order_no: ord.order_no,
      action: type,
      reason,
      performed_by: currentUser?.role || 'Admin',
      previous_status: ord.status,
      created_at: new Date().toISOString()
    };

    if (!Array.isArray(ord.action_logs)) ord.action_logs = [];
    ord.action_logs.unshift(logEntry);

    if (supabaseClient) {
      supabaseClient.from('order_audit_logs').insert(logEntry).then(() => {});
    }

    if (type === 'move_pending') {
      ord.status = 'Pending';
      await saveOrderToServer(ord);
      showAlert(`Order ${ord.order_no} moved back to Pending.`, 'success');
    } else if (type === 'archive') {
      ord.is_archived = true;
      ord.archived_at = new Date().toISOString();
      ord.archived_by = 'Admin';
      ord.archive_reason = reason;
      await saveOrderToServer(ord);
      showAlert(`Order ${ord.order_no} archived.`, 'success');
    } else if (type === 'trash') {
      ord.is_deleted = true;
      ord.deleted_at = new Date().toISOString();
      ord.deleted_by = 'Admin';
      ord.delete_reason = reason;
      await saveOrderToServer(ord);
      showAlert(`Order ${ord.order_no} moved to Trash.`, 'success');
    } else if (type === 'permanent_delete') {
      state.orders = state.orders.filter(o => safeId(o) !== ord.id);
      saveLocalState();
      if (supabaseClient) {
        try {
          await supabaseClient.from('orders').delete().eq('id', ord.id);
        } catch (_) {}
      }
      showAlert(`Order ${ord.order_no} permanently deleted.`, 'success');
    }

    closeAdminActionModal();
    renderAll();
  }

  async function restoreOrder(orderId) {
    const ord = state.orders.find(o => safeId(o) === String(orderId));
    if (!ord) return;
    ord.is_archived = false;
    ord.is_deleted = false;
    await saveOrderToServer(ord);
    renderAll();
    showAlert(`Order ${ord.order_no} restored to active list.`, 'success');
  }

  // ==========================================================================
  // RENDERING ALL SCREENS (DASHBOARD, CUTTING, TAILOR, REPORTS, ARCHIVED, TRASH, SETTINGS)
  // ==========================================================================
  function setStatusFilter(status) {
    const sel = safeEl('statusFilter');
    if (sel) sel.value = status;
    renderDashboard();
  }

  function renderOrderCardHtml(ord, context = 'dashboard') {
    const isAdmin = currentUser?.role === 'Admin';
    const isCutting = context === 'cutting';
    const hasSpecialCuts = Array.isArray(ord.special_cuts) && ord.special_cuts.length > 0;
    const cuttingBlocked = isCutting && hasSpecialCuts && !ord.special_cut_ack;

    const linesHtml = (ord.lines || [])
      .map(l => {
        const lineStr = formatLineForWorkScreen(l);
        return `<div class="order-line-bullet ${l.measurement_pending ? 'highlight-pending' : ''}">
          • ${esc(lineStr)}
        </div>`;
      })
      .join('');

    const specialCutBox = renderSpecialCutYellowBox(ord, isCutting);
    const svgThumb =
      ord.shape_data && ord.shape_data.template !== 'None'
        ? `<div style="max-width:220px;margin:6px 0;">${generateShapeSVGMarkup(ord.shape_data)}</div>`
        : '';

    const showPrices = currentUser?.role === 'Admin' || currentUser?.role === 'Sales';

    let actionButtons = '';
    if (context === 'archived') {
      actionButtons = `
        <button type="button" class="btn btn-sm btn-success" onclick="App.restoreOrder('${esc(ord.id)}')">↩ Restore</button>
        <button type="button" class="btn btn-sm btn-danger-outline" onclick="App.openAdminActionModal('trash', '${esc(ord.id)}')">🗑️ Move to Trash</button>
      `;
    } else if (context === 'trash') {
      const daysLeft = ord.deleted_at
        ? Math.max(0, 30 - Math.floor((Date.now() - new Date(ord.deleted_at).getTime()) / 86400000))
        : 30;
      actionButtons = `
        <span class="muted-sm">${daysLeft} days left in Trash</span>
        <button type="button" class="btn btn-sm btn-success" onclick="App.restoreOrder('${esc(ord.id)}')">↩ Restore</button>
        <button type="button" class="btn btn-sm btn-danger" onclick="App.openAdminActionModal('permanent_delete', '${esc(ord.id)}')">❌ Delete Permanently</button>
      `;
    } else {
      actionButtons = `
        <button type="button" class="btn btn-sm btn-outline" onclick="App.openStickerModal('${esc(ord.id)}')">🖨️ Sticker</button>
        ${
          showPrices
            ? `<button type="button" class="btn btn-sm btn-outline" onclick="App.openWaPreviewModal('${esc(
                ord.id
              )}', 'receipt')">💬 WhatsApp</button>
               <button type="button" class="btn btn-sm btn-outline" onclick="App.openEditOrder('${esc(ord.id)}')">✏️ Edit</button>`
            : ''
        }
        ${
          ord.status === 'Confirmed' || isCutting
            ? `<button type="button" class="btn btn-sm btn-primary" ${
                cuttingBlocked ? 'disabled title="Tick special cut checkbox first"' : ''
              } onclick="App.advanceOrderStatus('${esc(ord.id)}', 'Cutting OK')">✂️ Cutting OK</button>`
            : ''
        }
        ${
          ord.status === 'Cutting OK' || context === 'tailor'
            ? `<button type="button" class="btn btn-sm btn-success" onclick="App.advanceOrderStatus('${esc(
                ord.id
              )}', 'Ready')">🧵 Mark Ready</button>`
            : ''
        }
        ${
          ord.status === 'Ready' && showPrices
            ? `<button type="button" class="btn btn-sm btn-primary" onclick="App.advanceOrderStatus('${esc(
                ord.id
              )}', 'Delivered')">🚚 Delivered</button>`
            : ''
        }
        ${
          isAdmin && ord.status !== 'Pending'
            ? `<button type="button" class="btn btn-xs btn-outline" onclick="App.openAdminActionModal('move_pending', '${esc(
                ord.id
              )}')">⏪ Move back to Pending</button>`
            : ''
        }
        ${
          isAdmin
            ? `<button type="button" class="btn btn-xs btn-outline" onclick="App.openAdminActionModal('archive', '${esc(
                ord.id
              )}')">📦 Archive</button>
               <button type="button" class="btn btn-xs btn-danger-outline" onclick="App.openAdminActionModal('trash', '${esc(
                 ord.id
               )}')">🗑️ Delete</button>`
            : ''
        }
      `;
    }

    return `
      <div class="order-card">
        <div class="order-card-top">
          <div>
            <strong style="font-size:16px;">${esc(ord.order_no)}</strong> —
            <strong>${esc(ord.customer)}</strong>
            ${ord.phone ? `<span class="muted-sm">(${esc(ord.phone)})</span>` : ''}
            <div class="muted-sm">Promised: ${esc(ord.promised_date || 'N/A')} | Pieces: <strong>${esc(
      ord.pieces || 1
    )} Pcs</strong></div>
          </div>
          <div>
            <span class="status-badge status-${esc(ord.status.replace(/\s+/g, '-'))}">${esc(ord.status)}</span>
          </div>
        </div>

        <div class="order-lines-summary">${linesHtml}</div>
        ${svgThumb}
        ${specialCutBox}

        ${
          showPrices
            ? `<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin:8px 0;">
                <span>Total: <strong>₹${formatRs(ord.total)}</strong></span>
                <span>Advance: <strong>₹${formatRs(ord.advance)}</strong></span>
                <span>Balance: <strong style="color:#b91c1c;">₹${formatRs(ord.balance)}</strong></span>
               </div>`
            : ''
        }

        <div class="btn-row" style="margin-top:8px;">${actionButtons}</div>
      </div>
    `;
  }

  function renderDashboard() {
    const activeOrders = state.orders.filter(o => o && !o.is_archived && !o.is_deleted);
    const archivedOrders = state.orders.filter(o => o && o.is_archived && !o.is_deleted);
    const trashOrders = state.orders.filter(o => o && o.is_deleted);

    // Update counters
    const countBy = st => activeOrders.filter(o => o.status === st).length;
    if (safeEl('cntAll')) safeEl('cntAll').textContent = activeOrders.length;
    if (safeEl('cntPending')) safeEl('cntPending').textContent = countBy('Pending');
    if (safeEl('cntConfirmed')) safeEl('cntConfirmed').textContent = countBy('Confirmed');
    if (safeEl('cntCutting')) safeEl('cntCutting').textContent = countBy('Cutting OK');
    if (safeEl('cntReady')) safeEl('cntReady').textContent = countBy('Ready');
    if (safeEl('cntDelivered')) safeEl('cntDelivered').textContent = countBy('Delivered');

    if (safeEl('navCountCutting'))
      safeEl('navCountCutting').textContent = activeOrders.filter(o => o.status === 'Confirmed').length;
    if (safeEl('navCountTailor'))
      safeEl('navCountTailor').textContent = activeOrders.filter(o => o.status === 'Cutting OK').length;
    if (safeEl('navCountArchived')) safeEl('navCountArchived').textContent = archivedOrders.length;
    if (safeEl('navCountTrash')) safeEl('navCountTrash').textContent = trashOrders.length;

    const q = (safeEl('searchInput')?.value || '').trim().toLowerCase();
    const stFilter = safeEl('statusFilter')?.value || 'ALL';

    const filtered = activeOrders.filter(o => {
      if (stFilter !== 'ALL' && o.status !== stFilter) return false;
      if (!q) return true;
      const hay = `${o.order_no} ${o.customer} ${o.phone} ${(o.lines || [])
        .map(l => `${l.part} ${l.design}`)
        .join(' ')}`.toLowerCase();
      return hay.includes(q);
    });

    const listEl = safeEl('ordersListContainer');
    if (listEl) {
      listEl.innerHTML =
        filtered.length > 0
          ? filtered.map(o => renderOrderCardHtml(o, 'dashboard')).join('')
          : `<div class="card muted-sm">No matching active orders found.</div>`;
    }

    renderNotesBoard();
  }

  function renderCuttingAndTailor() {
    const active = state.orders.filter(o => o && !o.is_archived && !o.is_deleted);
    const cuttingOrders = active.filter(o => o.status === 'Confirmed' || o.status === 'Pending');
    const tailorOrders = active.filter(o => o.status === 'Cutting OK' || o.status === 'Confirmed');

    const cutWrap = safeEl('cuttingListContainer');
    if (cutWrap) {
      cutWrap.innerHTML =
        cuttingOrders.length > 0
          ? cuttingOrders.map(o => renderOrderCardHtml(o, 'cutting')).join('')
          : `<div class="card muted-sm">No orders waiting in Cutting queue.</div>`;
    }

    const tailorWrap = safeEl('tailorListContainer');
    if (tailorWrap) {
      tailorWrap.innerHTML =
        tailorOrders.length > 0
          ? tailorOrders.map(o => renderOrderCardHtml(o, 'tailor')).join('')
          : `<div class="card muted-sm">No orders waiting in Tailor queue.</div>`;
    }
  }

  function renderArchivedAndTrash() {
    const archived = state.orders.filter(o => o && o.is_archived && !o.is_deleted);
    const trash = state.orders.filter(o => o && o.is_deleted);

    const archEl = safeEl('archivedListContainer');
    if (archEl) {
      archEl.innerHTML =
        archived.length > 0
          ? archived.map(o => renderOrderCardHtml(o, 'archived')).join('')
          : `<div class="card muted-sm">No archived orders.</div>`;
    }

    const trashEl = safeEl('trashListContainer');
    if (trashEl) {
      trashEl.innerHTML =
        trash.length > 0
          ? trash.map(o => renderOrderCardHtml(o, 'trash')).join('')
          : `<div class="card muted-sm">Trash is empty.</div>`;
    }
  }

  function renderReports() {
    // Active non-archived, non-deleted orders only
    const active = state.orders.filter(o => o && !o.is_archived && !o.is_deleted);
    const totalSales = active.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const totalAdvance = active.reduce((s, o) => s + (Number(o.advance) || 0), 0);
    const totalBalance = active.reduce((s, o) => s + (Number(o.balance) || 0), 0);
    const totalPieces = active.reduce((s, o) => s + (Number(o.pieces) || 0), 0);

    const grid = safeEl('reportsSummaryGrid');
    if (grid) {
      grid.innerHTML = `
        <div class="counter-card"><span class="counter-label">Active Orders</span><strong class="counter-val">${active.length}</strong></div>
        <div class="counter-card confirmed"><span class="counter-label">Total Sales Value</span><strong class="counter-val">₹${formatRs(totalSales)}</strong></div>
        <div class="counter-card ready"><span class="counter-label">Advance Collected</span><strong class="counter-val">₹${formatRs(totalAdvance)}</strong></div>
        <div class="counter-card pending"><span class="counter-label">Pending Balance</span><strong class="counter-val">₹${formatRs(totalBalance)}</strong></div>
        <div class="counter-card cutting"><span class="counter-label">Total Pieces</span><strong class="counter-val">${totalPieces}</strong></div>
      `;
    }
  }

  // ==========================================================================
  // SETTINGS, WHATSAPP TEMPLATES EDITOR & DEVICE APPROVAL SWITCH
  // ==========================================================================
  function renderSettings() {
    if (safeEl('setShopName')) safeEl('setShopName').value = state.settings.shop_name || 'Shree Gayatri Furnishing Hub';
    if (safeEl('setShopPhone1')) safeEl('setShopPhone1').value = state.settings.shop_phone || '';
    if (safeEl('setShopPhone2')) safeEl('setShopPhone2').value = state.settings.shop_phone_2 || '';
    if (safeEl('setPinAdmin')) safeEl('setPinAdmin').value = state.settings.pins?.Admin || '1234';
    if (safeEl('setPinSales')) safeEl('setPinSales').value = state.settings.pins?.Sales || '1111';
    if (safeEl('setPinCutting')) safeEl('setPinCutting').value = state.settings.pins?.Cutting || '2222';
    if (safeEl('setPinTailor')) safeEl('setPinTailor').value = state.settings.pins?.Tailor || '3333';
    if (safeEl('setDeviceApprovalSwitch')) {
      safeEl('setDeviceApprovalSwitch').checked = Boolean(state.settings.device_approval_enabled);
    }
    if (safeEl('setSupabaseUrl')) safeEl('setSupabaseUrl').value = localStorage.getItem('sgf_supabase_url') || '';
    if (safeEl('setSupabaseKey')) safeEl('setSupabaseKey').value = localStorage.getItem('sgf_supabase_key') || '';

    renderDevicesTable();
    renderWaTemplatesEditor();
  }

  /**
   * FEATURE D: When turned ON, all devices currently in use are auto-approved so nobody is locked out!
   */
  function toggleDeviceApprovalSwitch(enabled) {
    state.settings.device_approval_enabled = Boolean(enabled);
    if (enabled) {
      // Auto-approve all currently known devices + current device
      ensureDeviceRegistered(currentUser?.role || 'Admin', true);
      state.devices.forEach(d => {
        if (d) {
          d.status = 'approved';
          syncDeviceToSupabase(d);
        }
      });
      showAlert('Device approval turned ON. All currently active devices were auto-approved.', 'success');
    } else {
      showAlert('Device approval turned OFF. Login works directly with PIN.', 'info');
    }

    saveLocalState();
    if (supabaseClient) {
      supabaseClient
        .from('app_settings')
        .upsert({ key: 'device_approval', value: { enabled: state.settings.device_approval_enabled } })
        .then(() => {});
    }
    renderDevicesTable();
  }

  function updateDeviceStatus(deviceId, newStatus) {
    if (newStatus === 'REMOVE') {
      state.devices = state.devices.filter(d => d && d.device_id !== deviceId);
      if (supabaseClient) {
        supabaseClient.from('registered_devices').delete().eq('device_id', deviceId).then(() => {});
      }
    } else {
      const dev = state.devices.find(d => d && d.device_id === deviceId);
      if (dev) {
        dev.status = newStatus;
        syncDeviceToSupabase(dev);
      }
    }
    saveLocalState();
    renderDevicesTable();
  }

  function renderDevicesTable() {
    const wrap = safeEl('devicesTableWrap');
    if (!wrap) return;
    const myDevId = getCurrentDeviceId();

    if (state.devices.length === 0) {
      wrap.innerHTML = `<p class="muted-sm">No registered devices yet.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;">
            <th style="padding:8px;">Device ID</th>
            <th style="padding:8px;">Device Info</th>
            <th style="padding:8px;">Role</th>
            <th style="padding:8px;">Status</th>
            <th style="padding:8px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.devices
            .map(
              d => `
            <tr style="border-bottom:1px solid #e2e8f0;">
              <td style="padding:8px;"><code>${esc(d.device_id)}</code> ${
                d.device_id === myDevId ? '<strong>(This device)</strong>' : ''
              }</td>
              <td style="padding:8px;">${esc(d.device_name)}</td>
              <td style="padding:8px;">${esc(d.role_used || '-')}</td>
              <td style="padding:8px;"><strong>${esc(d.status)}</strong></td>
              <td style="padding:8px;" class="btn-row">
                <button type="button" class="btn btn-xs btn-success" onclick="App.updateDeviceStatus('${esc(
                  d.device_id
                )}', 'approved')">Allow</button>
                <button type="button" class="btn btn-xs btn-outline" onclick="App.updateDeviceStatus('${esc(
                  d.device_id
                )}', 'rejected')">Reject</button>
                <button type="button" class="btn btn-xs btn-danger-outline" onclick="App.updateDeviceStatus('${esc(
                  d.device_id
                )}', 'REMOVE')">Remove</button>
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  function renderWaTemplatesEditor() {
    const wrap = safeEl('waTemplatesSettingsContainer');
    if (!wrap) return;
    const labels = {
      estimate: 'Estimate',
      receipt: 'Order receipt',
      ready: 'Ready',
      reminder: 'Balance reminder',
      delivered: 'Delivered'
    };

    wrap.innerHTML = Object.keys(labels)
      .map(key => {
        const tpl = state.settings.templates?.[key] || getDefaultTemplates()[key];
        return `
        <div class="card" style="background:#f8fafc;padding:10px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong>${esc(labels[key])}</strong>
            <select class="input" style="width:auto;" id="tplLang_${key}">
              <option value="Hinglish" ${tpl.lang === 'Hinglish' ? 'selected' : ''}>Simple Hinglish</option>
              <option value="English" ${tpl.lang === 'English' ? 'selected' : ''}>English</option>
              <option value="Hindi" ${tpl.lang === 'Hindi' ? 'selected' : ''}>Hindi</option>
              <option value="Gujarati" ${tpl.lang === 'Gujarati' ? 'selected' : ''}>Gujarati</option>
            </select>
          </div>
          <textarea class="input" rows="5" id="tplText_${key}">${esc(tpl.text)}</textarea>
        </div>
      `;
      })
      .join('');
  }

  function resetDefaultTemplates() {
    state.settings.templates = getDefaultTemplates();
    saveLocalState();
    renderWaTemplatesEditor();
    showAlert('Default Hinglish templates restored.', 'success');
  }

  function saveSettings() {
    state.settings.shop_name = (safeEl('setShopName')?.value || '').trim() || 'Shree Gayatri Furnishing Hub';
    state.settings.shop_phone = (safeEl('setShopPhone1')?.value || '').trim();
    state.settings.shop_phone_2 = (safeEl('setShopPhone2')?.value || '').trim();
    state.settings.pins = {
      Admin: (safeEl('setPinAdmin')?.value || '1234').trim(),
      Sales: (safeEl('setPinSales')?.value || '1111').trim(),
      Cutting: (safeEl('setPinCutting')?.value || '2222').trim(),
      Tailor: (safeEl('setPinTailor')?.value || '3333').trim()
    };

    const keys = ['estimate', 'receipt', 'ready', 'reminder', 'delivered'];
    for (const k of keys) {
      const lang = safeEl(`tplLang_${k}`)?.value || 'Hinglish';
      const text = safeEl(`tplText_${k}`)?.value || '';
      state.settings.templates[k] = { lang, text };
    }

    const sbUrl = (safeEl('setSupabaseUrl')?.value || '').trim();
    const sbKey = (safeEl('setSupabaseKey')?.value || '').trim();
    if (sbUrl) localStorage.setItem('sgf_supabase_url', sbUrl);
    if (sbKey) localStorage.setItem('sgf_supabase_key', sbKey);
    initSupabase();

    saveLocalState();
    if (supabaseClient) {
      supabaseClient
        .from('app_settings')
        .upsert({ key: 'general_settings', value: state.settings })
        .then(() => {});
    }
    showAlert('All settings saved!', 'success');
  }

  // ==========================================================================
  // BACKUP EXPORT / IMPORT & IMAGE MODAL
  // ==========================================================================
  function exportBackupJSON() {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SGF_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  function importBackupJSON(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = JSON.parse(e.target?.result || '{}');
        if (Array.isArray(parsed.orders)) {
          state.orders = parsed.orders.map(normalizeOrder).filter(Boolean);
        }
        if (Array.isArray(parsed.notes)) state.notes = parsed.notes;
        saveLocalState();
        renderAll();
        showAlert('Backup restored successfully!', 'success');
      } catch (err) {
        showAlert('Invalid backup JSON file.', 'error');
      }
    };
    reader.readAsText(file);
  }

  function exportCSV() {
    const active = state.orders.filter(o => o && !o.is_archived && !o.is_deleted);
    const rows = [
      ['Order No', 'Customer', 'Phone', 'Status', 'Promised Date', 'Pieces', 'Total', 'Advance', 'Balance', 'Lines']
    ];
    for (const o of active) {
      const linesSummary = (o.lines || []).map(formatLineForReceipt).join(' | ');
      rows.push([
        o.order_no,
        o.customer,
        o.phone,
        o.status,
        o.promised_date,
        o.pieces,
        o.total,
        o.advance,
        o.balance,
        linesSummary
      ]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SGF_Orders_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  function openImageModal(src) {
    if (!src) return;
    safeEl('imageModalImg').src = src;
    safeEl('imageModal')?.classList.remove('hidden');
  }

  function closeImageModal() {
    safeEl('imageModal')?.classList.add('hidden');
  }

  function renderAll() {
    renderDashboard();
    renderCuttingAndTailor();
    renderReports();
    renderArchivedAndTrash();
    if (currentTab === 'settings') renderSettings();
  }

  // Self-test verification on load (verifies required test cases in console)
  function runBuiltInSelfTests() {
    const t1_s = calculateLine({
      part: 'Seating',
      rate: 275,
      unit: 'inches_ft',
      segments: [{ length_expr: '102+102+36+78+24' }]
    });
    const t1_b = calculateLine({
      part: 'Back',
      rate: 200,
      unit: 'inches_ft',
      segments: [{ length_expr: '90+45+90+60+24' }]
    });
    const t1_h = calculateLine({
      part: 'Handle',
      rate: 200,
      unit: 'inches_ft',
      segments: [{ length_expr: '24+24+24' }]
    });
    console.assert(
      t1_s.amount === 7837 && t1_b.amount === 5150 && t1_h.amount === 1200 && t1_s.amount + t1_b.amount + t1_h.amount === 14187,
      'Test 1 failed'
    );

    const t2_s = calculateLine({
      part: 'Seating',
      rate: 225,
      unit: 'inches_ft',
      segments: [{ length_expr: '67+24+24' }]
    });
    const t2_b = calculateLine({
      part: 'Back',
      rate: 225,
      unit: 'inches_ft',
      segments: [{ length_expr: '63+21+21' }]
    });
    console.assert(t2_s.amount === 2193 && t2_b.amount === 1968 && t2_s.amount + t2_b.amount === 4161, 'Test 2 failed');

    const t3 = parseLengthExpr('24x4');
    console.assert(t3.totalInches === 96, 'Test 3 (24x4 -> 96") failed');
  }

  // Initialize on DOMContentLoaded
  window.addEventListener('DOMContentLoaded', () => {
    loadLocalState();
    initSupabase();
    runBuiltInSelfTests();
  });

  return {
    login,
    logout,
    recheckDeviceApproval,
    switchTab,
    syncAll,
    hideAlert,
    setStatusFilter,
    openNewOrder,
    openEditOrder,
    addOrderLine,
    removeOrderLine,
    addSegment,
    removeSegment,
    updateLineField,
    updateSegmentField,
    applyWidthChipToLine,
    recalcOrderTotals,
    onShapeTemplateChange,
    updateShapeSide,
     renderShapeSVG,
    addSpecialCut,
    removeSpecialCut,
    updateSpecialCut,
    handleSketchPhotoUpload,
    removeSketchPhoto,
    openReviewConfirmModal,
    closeReviewConfirmModal,
    saveOrderDirect,
    confirmOrderFlow,
    openStickerModal,
    closeStickerModal,
    printStickerNow,
    openWaPreviewModal,
    updateWaPreviewText,
    closeWaPreviewModal,
    copyWaPreviewText,
    sendWaNow,
    toggleSpecialCutAck,
    advanceOrderStatus,
    openAdminActionModal,
    closeAdminActionModal,
    executeAdminAction,
    restoreOrder,
    markNoteDone,
    toggleNotesHistory,
    scrollToNotesBoard,
    openQuickNoteModal,
    closeQuickNoteModal,
    saveQuickNote,
    toggleDeviceApprovalSwitch,
    updateDeviceStatus,
    resetDefaultTemplates,
    saveSettings,
    exportBackupJSON,
    importBackupJSON,
    exportCSV,
    openImageModal,
    closeImageModal,
    renderDashboard
  };
})();
