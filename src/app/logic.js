/**
 * Screen logic for the Business Management App.
 *
 * Ported from the imported Claude Design project by `tools/extract-logic.mjs`.
 * Each method assembles the view-model for one screen; the templates in
 * `src/templates` consume it. Master data arrives from the repository as
 * `this.data`, and writes are sent back through the repository rather than
 * mutated in place only.
 */
import { Component } from '../runtime/component.js';
import { C } from '../styles/tokens.js';
import { money, int, dec2, lakh } from '../domain/format.js';
import { cell, column, table } from '../components/dataTable.js';
import {
  DASHBOARD_KPIS,
  MONTHLY_SERIES,
  TOP_CUSTOMERS,
  TOP_COMPANIES,
  AGING_BUCKETS,
  PROFIT_AND_LOSS,
  REPORT_GROUPS,
} from '../data/analytics.js';
import {
  EMPLOYEES,
  PERMISSION_MATRIX,
  PHONE_SCREENS,
  FINANCIAL_YEARS,
  NUMBERING,
  UNIT_CONVERSIONS,
  PAYMENT_METHODS,
  NOTIFICATION_RULES,
} from '../data/reference.js';

export class BusinessApp extends Component {
  /**
   * @param {object} props  role, showProfit, approvalLimit, repository
   * @param {object} data   working set loaded by the repository
   */
  constructor(props, data) {
    super(props);
    this.data = data;
    this.repository = props.repository || null;
    this.state = {
      screen:'dashboard', biz:'all', q:'', qOpen:false, notifOpen:false, userOpen:false, toast:null,
      invTab:'all', invSort:'value', acctTab:'receivable', setSec:'company', repSel:'crop-batch-profit', repLoading:false,
      custSel:'CUS-003', custTab:'purchases', supSel:'SUP-001', supTab:'purchases', valuation:'FIFO',
      cp:{sup:'SUP-001', crop:'Maize', grade:'A (Premium)', wh:'Naogaon Central Godown', date:'2026-08-28', qty:100, unit:'MT', moist:1.5, rate:30000, transport:50000, loading:12000, unloading:8000, other:0, advance:1500000, note:''},
      extraCusts:[], custModal:false,
      newCust:{name:'', bn:'', type:'Dealer', person:'', mobile:'', district:'Bogura', upazila:'', limit:500000, days:15, opening:0},
      cs:{buyer:'PRAN Agro Business Ltd.', crop:'Maize', date:'2026-08-28', rate:34500, transport:15000, other:5000, target:40, alloc:{}},
      ds:{cust:'CUS-002', date:'2026-08-28', sp:'Shamim Reza', wh:'Bogura Depot', terms:'Credit 15 days', paid:150000,
        lines:[{pid:'P-1001', qty:120, rate:295, disc:2, bonus:4}, {pid:'P-1004', qty:60, rate:510, disc:0, bonus:0}]},
      dp:{co:'CMP-01', inv:'ACI/DH/26-4471', date:'2026-08-27', wh:'Bogura Depot', terms:'Credit 30 days', transport:18000, other:4500,
        lines:[{pid:'P-1001', qty:600, free:24, rate:245, disc:3}, {pid:'P-1003', qty:200, free:0, rate:180, disc:0}]},
      batches: data.batches,
      approvals: data.approvals,
      cropLog: data.cropLog,
      saleLog: data.saleLog,
      notifs: data.notifications,
    };
  }

  go(id) { return () => this.setState({screen:id, qOpen:false, notifOpen:false, userOpen:false, q:''}); }
  h(g, k, num) { return e => { const v = num ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value; this.setState(s => { const o = Object.assign({}, s[g]); o[k] = v; return {[g]:o}; }); }; }
  hs(k, v) { return () => this.setState({[k]:v}); }
  tabify(arr, cur, key) { return arr.map(x => ({l:x.l, on:x.k === cur, bg:x.k === cur ? '#fff' : 'transparent',
    color:x.k === cur ? C.ink : C.mut, onClick:this.hs(key, x.k)})); }
  fire(msg, tone) { this.setState({toast:{msg:msg, tone:tone || 'ok'}}); clearTimeout(this._t); this._t = setTimeout(() => this.setState({toast:null}), 3600); }
  componentWillUnmount() { clearTimeout(this._t); }

  role() { return this.props.role || 'Admin'; }
  canProfit() { const p = this.props.showProfit; return (p === undefined ? true : !!p) && ['Admin', 'Management', 'Accounts'].indexOf(this.role()) > -1; }
  limit() { return Number(this.props.approvalLimit || 500000); }

  bizOf(v) { const b = this.state.biz; return b === 'dealer' ? v.d : b === 'crop' ? v.c : v.d + v.c; }
  custList() { return this.data.customers.concat(this.state.extraCusts || []); }

  /**
   * Send a write through the repository. Falls back to resolving the payload
   * unchanged when no repository is wired, so the logic stays testable.
   *
   * A write already in flight blocks another of the same kind: double-clicking
   * Post must never create two transactions. The guard is here rather than on
   * the button so it holds however the action is triggered.
   */
  persist(method, ...args) {
    if (!this._inFlight) this._inFlight = new Set();

    if (this._inFlight.has(method)) {
      // A second click while the first is still saving is ignored rather than
      // reported: the user did nothing wrong, and an error toast would be noise.
      const ignored = /** @type {Error & {silent?: boolean}} */ (new Error('Already saving.'));
      ignored.silent = true;
      return Promise.reject(ignored);
    }
    this._inFlight.add(method);
    this.setState({ busy: method });
    // Immediate feedback, replaced by the outcome when the write settles.
    this.fire('Saving…', 'ok');

    const done = () => {
      this._inFlight.delete(method);
      this.setState({ busy: null });
    };

    const call =
      this.repository && typeof this.repository[method] === 'function'
        ? this.repository[method](...args)
        : Promise.resolve(args[0]);

    return call.then(
      (value) => { done(); return value; },
      (err) => { done(); throw err; }
    );
  }

  saveCustomer() {
    const f = this.state.newCust;
    if (!f.name.trim() || !f.mobile.trim()) { this.fire('Customer name and mobile number are required.', 'danger'); return; }
    const code = 'CUS-' + ('00' + (this.data.customers.length + (this.state.extraCusts || []).length + 1)).slice(-3);
    const c = {code:code, name:f.name, bn:f.bn || '', type:f.type, person:f.person, mobile:f.mobile, district:f.district, upazila:f.upazila,
      limit:+f.limit || 0, days:+f.days || 0, sales:0, coll:0, out:+f.opening || 0, last:'—', b30:+f.opening || 0, b60:0, b90:0, b90p:0};
    this.persist('createCustomer', c).then(saved => {
      this.setState(s => ({extraCusts:(s.extraCusts || []).concat([saved]), custModal:false, custSel:code,
        ds:Object.assign({}, s.ds, {cust:code}),
        newCust:{name:'', bn:'', type:'Dealer', person:'', mobile:'', district:'Bogura', upazila:'', limit:500000, days:15, opening:0}}));
      this.fire(code + ' — ' + f.name + ' created and selected on this invoice', 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not save customer — ' + err.message, 'danger'); });
  }

  calcCP() {
    const f = this.state.cp, S = this.state;
    const gross = +f.qty || 0, ded = gross * (+f.moist || 0) / 100, net = gross - ded;
    const pv = net * (+f.rate || 0);
    const add = (+f.transport || 0) + (+f.loading || 0) + (+f.unloading || 0) + (+f.other || 0);
    const total = pv + add, cpu = net ? total / net : 0;
    const last = this.data.lastRate[f.crop] || 0, diff = (+f.rate || 0) - last;
    const sup = this.data.suppliers.filter(s => s.code === f.sup)[0] || this.data.suppliers[0];
    const adv = +f.advance || 0;
    return {v:f, sup:sup, supOutText:money(sup.out), supPurText:lakh(sup.pur), grossText:dec2(gross) + ' ' + f.unit, dedText:'− ' + dec2(ded) + ' ' + f.unit,
      netText:dec2(net) + ' ' + f.unit, net:net, pvText:money(pv), addText:money(add), totalText:money(total), total:total,
      cpuText:money(cpu), cpuNum:cpu, perUnitLabel:'per ' + f.unit, lastText:money(last),
      diffText:(diff >= 0 ? '+' : '−') + money(Math.abs(diff)).slice(1) + ' vs last purchase', diffColor:diff > 0 ? C.dngr : C.crop,
      advText:money(adv), balText:money(pv - adv), needAppr:total > this.limit(), limitText:money(this.limit()),
      batchId:'BC-2608-0' + (12 + S.cropLog.length - 4), purNo:'PC-2608-014',
      crops:this.data.crops, grades:this.data.grades, whs:this.data.warehouses, units:this.data.units, sups:this.data.suppliers,
      log:table([column('Purchase No'), column('Date'), column('Supplier'), column('Crop'), column('Qty', 'right'), column('Rate', 'right'), column('Landed cost / unit', 'right'), column('Total', 'right'), column('Status', 'center')],
        S.cropLog.map(r => ({cells:[cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.sup), cell(r.crop, {dot:C.crop}),
          cell(int(r.qty) + ' ' + r.unit, {align:'right', mono:true}), cell(money(r.rate), {align:'right', mono:true}),
          cell(money(r.cpu), {align:'right', mono:true, color:C.crop, weight:'600'}), cell(money(r.total), {align:'right', mono:true, weight:'600'}),
          cell(r.status, {align:'center', badge:true, badgeBg:r.status === 'Posted' ? C.cropBg : '#F0EEE9', badgeFg:r.status === 'Posted' ? C.crop : '#6E6A64'})]}))
      )};
  }

  postCP() {
    const c = this.calcCP(), f = this.state.cp;
    if (!c.net) { this.fire('Enter a quantity before posting.', 'danger'); return; }
    const no = 'PC-2608-0' + (14 + this.state.cropLog.length - 5);
    const batch = {id:c.batchId, crop:f.crop, grade:f.grade, wh:f.wh, qty:c.net, rem:c.net, cost:c.cpuNum, date:'28 Aug 2026', age:0, sup:c.sup.name};
    const logRow = {no:no, date:'28 Aug 2026', sup:c.sup.name, crop:f.crop, qty:c.net, unit:f.unit, rate:+f.rate || 0, cpu:c.cpuNum, total:c.total, status:c.needAppr ? 'Pending approval' : 'Posted'};
    const intent = {date:'2026-08-28', supplierCode:f.sup, crop:f.crop, grade:f.grade, warehouse:f.wh,
      quantity:+f.qty || 0, unit:f.unit, moisture:+f.moist || 0, rate:+f.rate || 0,
      transport:+f.transport || 0, loading:+f.loading || 0, unloading:+f.unloading || 0,
      other:+f.other || 0, advance:+f.advance || 0, note:f.note};
    this.persist('postCropPurchase', {logRow:logRow, batch:batch, intent:intent}).then(saved => {
      this.setState(s => ({
        batches:[saved.batch].concat(s.batches),
        cropLog:[saved.logRow].concat(s.cropLog)
      }));
      this.fire(c.needAppr ? no + ' saved and sent for approval — ' + money(c.total) : no + ' posted · batch ' + c.batchId + ' added to stock', c.needAppr ? 'warn' : 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not post purchase — ' + err.message, 'danger'); });
  }

  calcCS() {
    const f = this.state.cs, S = this.state, val = S.valuation;
    const pool = S.batches.filter(b => b.crop === f.crop && b.rem > 0).slice().sort((a, b) => b.age - a.age);
    const avgCost = pool.length ? pool.reduce((t, b) => t + b.cost * b.rem, 0) / pool.reduce((t, b) => t + b.rem, 0) : 0;
    let allocQty = 0, cogs = 0, over = false;
    const rows = pool.map(b => {
      const a = +f.alloc[b.id] || 0; if (a > b.rem) over = true;
      allocQty += a; cogs += a * (val === 'FIFO' ? b.cost : avgCost);
      return {id:b.id, grade:b.grade, wh:b.wh, remText:dec2(b.rem) + ' MT', costText:money(b.cost), ageText:b.age + ' days', supName:b.sup, date:b.date,
        qtyVal:f.alloc[b.id] === undefined ? '' : f.alloc[b.id], over:a > b.rem, leftText:dec2(Math.max(0, b.rem - a)) + ' MT left after sale',
        onQty:e => { const v = e.target.value === '' ? '' : Number(e.target.value); this.setState(s => { const al = Object.assign({}, s.cs.alloc); al[b.id] = v; return {cs:Object.assign({}, s.cs, {alloc:al})}; }); }};
    });
    const sales = allocQty * (+f.rate || 0), exp = (+f.transport || 0) + (+f.other || 0);
    const profit = sales - cogs - exp, per = allocQty ? profit / allocQty : 0, margin = sales ? profit / sales * 100 : 0;
    return {v:f, rows:rows, pool:pool, crops:this.data.crops, buyers:this.data.buyers, salesNo:'SC-2608-052',
      allocText:dec2(allocQty) + ' MT', allocQty:allocQty, over:over,
      salesText:money(sales), cogsText:'− ' + money(cogs).slice(1), expText:'− ' + money(exp).slice(1),
      profitText:money(profit), profitColor:profit >= 0 ? C.crop : C.dngr, perText:money(per) + ' / MT',
      marginText:margin.toFixed(2) + '%', avgCostText:money(avgCost), valuation:val,
      rateText:money(+f.rate || 0), showProfit:this.canProfit(), needAppr:sales > this.limit() * 4,
      log:table([column('Sales No'), column('Date'), column('Buyer company'), column('Crop'), column('Batch'), column('Qty', 'right'), column('Rate', 'right'), column('Sales value', 'right'), column('Gross profit', 'right')],
        S.saleLog.map(r => ({cells:[cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.buyer), cell(r.crop, {dot:C.crop}),
          cell(r.batch, {mono:true, color:C.mut}), cell(int(r.qty) + ' MT', {align:'right', mono:true}), cell(money(r.rate), {align:'right', mono:true}),
          cell(money(r.amt), {align:'right', mono:true, weight:'600'}),
          cell(this.canProfit() ? money(r.profit) : '—', {align:'right', mono:true, color:C.crop, weight:'600'})]}))
      )};
  }

  postCS() {
    const c = this.calcCS(), f = this.state.cs;
    if (c.over) { this.fire('Allocation exceeds remaining stock in one or more batches.', 'danger'); return; }
    if (!c.allocQty) { this.fire('Allocate quantity from at least one batch.', 'danger'); return; }
    const logRow = {no:c.salesNo, date:'28 Aug 2026', buyer:f.buyer, crop:f.crop, batch:c.rows.filter(r => (+f.alloc[r.id] || 0) > 0).map(r => r.id).join(', '),
      qty:c.allocQty, rate:+f.rate || 0, amt:c.allocQty * (+f.rate || 0), profit:0, status:'Posted'};
    const intent = {date:'2026-08-28', buyerName:f.buyer, crop:f.crop, quantity:c.allocQty,
      rate:+f.rate || 0, transport:+f.transport || 0, other:+f.other || 0,
      valuation:this.state.valuation};
    this.persist('postCropSale', {logRow:logRow, allocations:Object.assign({}, f.alloc), intent:intent}).then(saved => {
      this.setState(s => ({
        batches:s.batches.map(b => { const a = +saved.allocations[b.id] || 0; return a ? Object.assign({}, b, {rem:b.rem - a}) : b; }),
        saleLog:[saved.logRow].concat(s.saleLog),
        cs:Object.assign({}, s.cs, {alloc:{}})
      }));
      this.fire(c.salesNo + ' posted · ' + c.allocText + ' issued, stock and buyer receivable updated', 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not post sale — ' + err.message, 'danger'); });
  }

  autoAlloc() {
    const f = this.state.cs, target = +f.target || 0;
    const pool = this.state.batches.filter(b => b.crop === f.crop && b.rem > 0).slice().sort((a, b) => b.age - a.age);
    let left = target; const al = {};
    pool.forEach(b => { const take = Math.min(left, b.rem); if (take > 0) al[b.id] = take; left -= take; });
    this.setState(s => ({cs:Object.assign({}, s.cs, {alloc:al})}));
    this.fire(left > 0 ? 'Only ' + dec2(target - left) + ' MT available — allocated oldest batches first' : 'Allocated ' + dec2(target) + ' MT, oldest batch first (FIFO)', left > 0 ? 'warn' : 'ok');
  }

  /**
   * Post a dealer sales invoice.
   *
   * The design's button only raised a toast; posting now goes through the
   * repository, so against the API it moves stock, raises the receivable and
   * writes the ledger, and the toast reports what the server actually did.
   */
  postDS(available, due) {
    if (available < 0) {
      this.fire('Credit limit exceeded — approval required before posting.', 'danger');
      return;
    }

    const f = this.state.ds;
    const cust = this.custList().filter(c => c.code === f.cust)[0];
    const intent = {date:'2026-08-28', customerCode:f.cust, warehouse:f.wh, terms:f.terms,
      paid:+f.paid || 0,
      lines:f.lines.map(l => { const p = this.data.products.filter(x => x.code === l.pid)[0] || {};
        return {productCode:l.pid, quantity:+l.qty || 0, bonus:+l.bonus || 0,
          rate:+l.rate || 0, discount:+l.disc || 0, unit:p.unit}; })};

    this.persist('postDealerSale', {intent:intent, customer:cust, due:due}).then(saved => {
      const no = saved && saved.txnNo ? saved.txnNo : 'DS-2608-222';
      if (saved && saved.status === 'PENDING_APPROVAL') {
        this.fire(no + ' saved and sent for approval', 'warn');
      } else if (due > 0) {
        this.fire(no + ' posted · stock reduced, receivable ' + money(due) + ' created', 'ok');
      } else if (due < 0) {
        // Paid more than the invoice: the surplus sits on account, and no
        // receivable is raised. Saying "receivable −৳84,708 created" would be
        // nonsense, and the server does not create one either.
        this.fire(no + ' posted · settled in full, ' + money(-due) + ' left on account', 'ok');
      } else {
        this.fire(no + ' posted · stock reduced, settled in full', 'ok');
      }
    }).catch(err => { if (!err.silent) this.fire(err.message, 'danger'); });
  }

  /** Post a dealer purchase bill. */
  postDP(net) {
    const f = this.state.dp;
    const co = this.data.companies.filter(c => c.code === f.co)[0];
    const intent = {date:'2026-08-28', companyCode:f.co, warehouse:f.wh, invoiceNo:f.inv,
      terms:f.terms, transport:+f.transport || 0, other:+f.other || 0,
      lines:f.lines.map(l => ({productCode:l.pid, quantity:+l.qty || 0, free:+l.free || 0,
        rate:+l.rate || 0, discount:+l.disc || 0}))};

    this.persist('postDealerPurchase', {intent:intent, company:co, net:net}).then(saved => {
      const no = saved && saved.txnNo ? saved.txnNo : 'DP-2608-072';
      if (saved && saved.status === 'PENDING_APPROVAL') {
        this.fire(no + ' saved, approval requested above ' + money(this.limit()), 'warn');
      } else {
        this.fire(no + ' posted · stock and company payable updated', 'ok');
      }
    }).catch(err => { if (!err.silent) this.fire(err.message, 'danger'); });
  }

  calcDS() {
    const f = this.state.ds, all = this.custList(), cust = all.filter(c => c.code === f.cust)[0] || all[0];
    let gross = 0, discAmt = 0, cost = 0;
    const lines = f.lines.map((l, i) => {
      const p = this.data.products.filter(x => x.code === l.pid)[0] || this.data.products[0];
      const amt = (+l.qty || 0) * (+l.rate || 0), d = amt * (+l.disc || 0) / 100, net = amt - d;
      gross += amt; discAmt += d; cost += (+l.qty || 0) * p.pur;
      return {i:i, pid:l.pid, name:p.name, unit:p.unit, stockText:int(p.stock) + ' ' + p.unit, lastText:money(p.sale),
        qtyVal:l.qty, rateVal:l.rate, discVal:l.disc, bonusVal:l.bonus, netText:money(net),
        low:(+l.qty || 0) > p.stock, products:this.data.products,
        onProduct:e => this.setState(s => { const L = s.ds.lines.slice(); const np = this.data.products.filter(x => x.code === e.target.value)[0]; L[i] = Object.assign({}, L[i], {pid:e.target.value, rate:np.sale}); return {ds:Object.assign({}, s.ds, {lines:L})}; }),
        onQty:e => this.setLine('ds', i, 'qty', e.target.value), onRate:e => this.setLine('ds', i, 'rate', e.target.value),
        onDisc:e => this.setLine('ds', i, 'disc', e.target.value), onBonus:e => this.setLine('ds', i, 'bonus', e.target.value),
        onDel:() => this.setState(s => ({ds:Object.assign({}, s.ds, {lines:s.ds.lines.filter((_, k) => k !== i)})}))};
    });
    const vat = 0, net = gross - discAmt + vat, profit = net - cost, margin = net ? profit / net * 100 : 0;
    const paid = +f.paid || 0, due = net - paid;
    const exposure = cust.out + due, avail = cust.limit - exposure;
    return {v:f, cust:cust, lines:lines, custs:all, whs:this.data.warehouses, invNo:'DS-2608-222',
      modal:this.state.custModal, nc:this.state.newCust,
      onNew:() => this.setState({custModal:true}), onCancel:() => this.setState({custModal:false}), onSave:() => this.saveCustomer(),
      types:['Dealer', 'Retailer', 'Corporate', 'Company', 'Individual', 'Other'],
      districts:['Bogura', 'Rangpur', 'Naogaon', 'Dinajpur', 'Jashore', 'Rajshahi', 'Pabna', 'Natore'],
      grossText:money(gross), discText:'− ' + money(discAmt).slice(1), netText:money(net), costText:money(cost),
      profitText:money(profit), marginText:margin.toFixed(2) + '%', profitColor:profit >= 0 ? C.crop : C.dngr,
      paidText:money(paid), dueText:money(due), limitText:money(cust.limit), outText:money(cust.out),
      availText:money(avail), availColor:avail < 0 ? C.dngr : C.crop, overLimit:avail < 0,
      showProfit:this.canProfit(), lineCount:lines.length + ' line items',
      onAdd:() => this.setState(s => ({ds:Object.assign({}, s.ds, {lines:s.ds.lines.concat([{pid:'P-1002', qty:10, rate:385, disc:0, bonus:0}])})})),
      onPost:() => this.postDS(avail, due)};
  }

  setLine(g, i, k, raw) {
    const v = raw === '' ? '' : Number(raw);
    this.setState(s => { const L = s[g].lines.slice(); L[i] = Object.assign({}, L[i], {[k]:v}); return {[g]:Object.assign({}, s[g], {lines:L})}; });
  }

  calcDP() {
    const f = this.state.dp, co = this.data.companies.filter(c => c.code === f.co)[0] || this.data.companies[0];
    let gross = 0, discAmt = 0, freeQty = 0;
    const lines = f.lines.map((l, i) => {
      const p = this.data.products.filter(x => x.code === l.pid)[0] || this.data.products[0];
      const amt = (+l.qty || 0) * (+l.rate || 0), d = amt * (+l.disc || 0) / 100;
      gross += amt; discAmt += d; freeQty += +l.free || 0;
      const eff = ((+l.qty || 0) + (+l.free || 0)) ? (amt - d) / ((+l.qty || 0) + (+l.free || 0)) : 0;
      return {i:i, pid:l.pid, name:p.name, unit:p.unit, stockText:int(p.stock) + ' ' + p.unit, lastText:money(p.pur),
        qtyVal:l.qty, freeVal:l.free, rateVal:l.rate, discVal:l.disc, netText:money(amt - d), effText:money(eff), products:this.data.products,
        onProduct:e => this.setState(s => { const L = s.dp.lines.slice(); const np = this.data.products.filter(x => x.code === e.target.value)[0]; L[i] = Object.assign({}, L[i], {pid:e.target.value, rate:np.pur}); return {dp:Object.assign({}, s.dp, {lines:L})}; }),
        onQty:e => this.setLine('dp', i, 'qty', e.target.value), onFree:e => this.setLine('dp', i, 'free', e.target.value),
        onRate:e => this.setLine('dp', i, 'rate', e.target.value), onDisc:e => this.setLine('dp', i, 'disc', e.target.value),
        onDel:() => this.setState(s => ({dp:Object.assign({}, s.dp, {lines:s.dp.lines.filter((_, k) => k !== i)})}))};
    });
    const addl = (+f.transport || 0) + (+f.other || 0), net = gross - discAmt + addl;
    return {v:f, co:co, cos:this.data.companies, whs:this.data.warehouses, lines:lines, purNo:'DP-2608-072',
      grossText:money(gross), discText:'− ' + money(discAmt).slice(1), addlText:money(addl), netText:money(net),
      freeText:int(freeQty) + ' pcs free', payableText:money(co.bal + net), coBalText:money(co.bal),
      needAppr:net > this.limit(), limitText:money(this.limit()),
      onAdd:() => this.setState(s => ({dp:Object.assign({}, s.dp, {lines:s.dp.lines.concat([{pid:'P-1002', qty:100, free:0, rate:318, disc:0}])})})),
      onPost:() => this.postDP(net)};
  }

  /**
   * Pull dashboard aggregates from the repository when it can compute them.
   *
   * The in-memory repository has no `dashboard` method, so nothing changes
   * there and the bundled figures are used. Against the API the totals are
   * aggregated in SQL, which is what makes the business-type filter reconcile:
   * All is the sum of Dealer and Bulk Crop because the database says so.
   */
  loadDashboard() {
    if (!this.repository || typeof this.repository.dashboard !== 'function') return;

    const biz = this.state.biz;
    const businessType = biz === 'dealer' ? 'DEALER' : biz === 'crop' ? 'BULK_CROP' : 'ALL';

    this.setState({ dashLoading: true });
    this.repository.dashboard(businessType).then(
      data => {
        // A stale response from a filter the user has since changed is dropped.
        if (this.state.biz === biz) this.setState({ serverDash: data, dashLoading: false });
      },
      () => this.setState({ dashLoading: false })
    );
  }

  /**
   * Map server aggregates onto the eight tiles the design shows.
   *
   * The supporting line states a fact the server actually returned -- a
   * document count, an account count -- rather than a period-on-period
   * percentage, because the API does not compute comparisons and inventing
   * one would put a number on screen that nothing backs.
   */
  serverKpis(d) {
    const tile = (k, value, note, detail, good) => ({
      k: k,
      v: money(value),
      sub: lakh(value),
      note: note,
      up: detail,
      upColor: good ? C.crop : C.warn,
    });

    const today = d.today || {sales:{amount:0, documents:0}};
    const profit = d.grossProfit;

    const out = [
      tile("Today's Sales", today.sales.amount, today.sales.documents + ' invoices', 'posted today', true),
      tile('This Month Sales', d.sales.amount, d.sales.documents + ' invoices', 'posted to date', true),
      tile('This Month Purchase', d.purchases.amount, d.purchases.documents + ' bills', 'posted to date', true),
    ];

    if (profit) {
      out.push(tile('Gross Profit', profit.amount, 'margin ' + profit.marginPct.toFixed(1) + '%',
        'sales less cost of goods', profit.amount >= 0));
    }

    out.push(
      tile('Outstanding Receivable', d.receivable.amount, d.receivable.documents + ' open invoices',
        'awaiting collection', false),
      tile('Outstanding Payable', d.payable.amount, d.payable.documents + ' bills', 'due to suppliers', false),
      tile('Current Stock Value', d.stock.totalValue, d.stock.batches + ' crop batches',
        'across all warehouses', true),
      tile('Cash & Bank Balance', d.cash.balance, d.cash.accounts + ' accounts', 'cash, bank and MFS', true)
    );

    return out;
  }

  /** Rows for one business-line panel, from that line's server aggregate. */
  businessPanelRows(d) {
    if (!d) return [];
    const rows = [
      {k:'Sales', v:money(d.sales.amount)},
      {k:'Purchase', v:money(d.purchases.amount)},
    ];
    if (d.grossProfit) {
      rows.push({k:'Gross profit', v:money(d.grossProfit.amount)});
    }
    rows.push(
      {k:'Outstanding', v:money(d.receivable.amount)},
      {k:'Stock value', v:money(d.stock.totalValue)}
    );
    if (d.grossProfit) {
      rows.push({k:'Margin', v:d.grossProfit.marginPct.toFixed(1) + '%'});
    }
    return rows;
  }

  dash() {
    const K = DASHBOARD_KPIS;
    const sd = this.state.serverDash;
    const kpis = sd ? this.serverKpis(sd) : K.map(x => {
      const v = x.fix !== undefined ? x.fix : this.bizOf(x);
      return {k:x.k, v:money(v), sub:lakh(v), note:x.note, up:x.up, upColor:x.good ? C.crop : C.warn};
    });
    const months = MONTHLY_SERIES;
    const b = this.state.biz;
    const series = months.map(x => { const s = b === 'dealer' ? x.ds : b === 'crop' ? x.cs : x.ds + x.cs; const p = b === 'dealer' ? x.dp : b === 'crop' ? x.cp : x.dp + x.cp; return {l:x.l, s:s, p:p, pr:s - p}; });
    const max = Math.max.apply(null, series.map(x => x.s)) * 1.12;
    const chart = series.map(x => ({l:x.l, sH:(x.s / max * 150).toFixed(1) + 'px', pH:(x.p / max * 150).toFixed(1) + 'px',
      sText:'৳' + x.s.toFixed(1) + ' L', tip:x.l + ' — sales ৳' + x.s.toFixed(1) + ' L · purchase ৳' + x.p.toFixed(1) + ' L · profit ৳' + x.pr.toFixed(1) + ' L'}));
    const byBiz = sd && sd.byBusiness;
    const panels = byBiz ? [
      {name:'Dealer Business', color:C.deal, bg:C.dealBg, tag:'Company → Dealer → Customer', screen:'dealer-sales',
        rows:this.businessPanelRows(byBiz.DEALER)},
      {name:'Bulk Crop Business', color:C.crop, bg:C.cropBg, tag:'Farmer → Us → Buyer company', screen:'crop-sales',
        rows:this.businessPanelRows(byBiz.BULK_CROP)}
    ] : [
      {name:'Dealer Business', color:C.deal, bg:C.dealBg, tag:'Company → Dealer → Customer', screen:'dealer-sales',
        rows:[{k:'Sales', v:money(9840000)}, {k:'Purchase', v:money(7210000)}, {k:'Gross profit', v:money(1486000)}, {k:'Outstanding', v:money(1580000)}, {k:'Stock value', v:money(5620000)}, {k:'Margin', v:'15.1%'}]},
      {name:'Bulk Crop Business', color:C.crop, bg:C.cropBg, tag:'Farmer → Us → Buyer company', screen:'crop-sales',
        rows:[{k:'Crop purchased', v:'642 MT'}, {k:'Crop sold', v:'478 MT'}, {k:'Purchase value', v:money(21150000)}, {k:'Sales value', v:money(24600000)}, {k:'Avg purchase rate', v:money(32945) + ' / MT'}, {k:'Avg selling rate', v:money(36180) + ' / MT'}]}
    ];
    const topCust = TOP_CUSTOMERS;
    const topCo = TOP_COMPANIES;
    const bar = arr => { const mx = arr[0].v; return arr.map(x => ({n:x.n, v:lakh(x.v), w:(x.v / mx * 100).toFixed(1) + '%'})); };
    const aging = AGING_BUCKETS;
    const agMax = 1870000;
    return {kpis:kpis, chart:chart, panels:panels, showProfit:this.canProfit(),
      topCust:bar(topCust), topCo:bar(topCo),
      aging:aging.map(x => ({k:x.k, v:money(x.v), w:(x.v / agMax * 100).toFixed(1) + '%', c:x.c})),
      low:[{n:'Ispahani TSP Fertilizer 50kg', d:'74 of 120 bags minimum', p:'62%'}, {n:'ACI Zinc Sulphate 1kg', d:'210 of 250 pcs minimum', p:'84%'},
        {n:'Onion — batch BC-2606-001', d:'14 MT, 73 days old, dead stock risk', p:'35%'}],
      actions:[{l:'New Crop Purchase', id:'crop-purchase'}, {l:'New Crop Sale', id:'crop-sales'}, {l:'New Dealer Sale', id:'dealer-sales'}, {l:'New Dealer Purchase', id:'dealer-purchase'},
        {l:'Receive Payment', id:'accounts'}, {l:'Pay Supplier', id:'accounts'}, {l:'Stock Transfer', id:'inventory'}, {l:'Add Expense', id:'accounts'}].map(a => ({l:a.l, onClick:this.go(a.id)})),
      recent:table([column('Reference'), column('Date'), column('Type'), column('Party'), column('Business'), column('Amount', 'right'), column('Status', 'center')],
        [['SC-2608-051', '26 Aug', 'Crop sale', 'City Group (Rice Unit)', 'crop', 2952000, 'Posted'],
         ['DS-2608-221', '28 Aug', 'Dealer sale', 'Nabin Krishi Bitan', 'dealer', 1328000, 'Pending approval'],
         ['PC-2608-014', '28 Aug', 'Crop purchase', 'Abdul Karim Mondol', 'crop', 3020000, 'Pending approval'],
         ['RC-2608-310', '28 Aug', 'Collection', 'Sonar Bangla Enterprise', 'dealer', 450000, 'Posted'],
         ['DP-2608-071', '27 Aug', 'Dealer purchase', 'ACI Agrochemicals Ltd.', 'dealer', 892400, 'Posted'],
         ['PY-2608-118', '27 Aug', 'Supplier payment', 'Jashim Uddin Sarkar', 'crop', 1200000, 'Posted']].map(r => ({cells:[
          cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3]),
          cell(r[4] === 'crop' ? 'Bulk Crop' : 'Dealer', {badge:true, badgeBg:r[4] === 'crop' ? C.cropBg : C.dealBg, badgeFg:r[4] === 'crop' ? C.crop : C.deal}),
          cell(money(r[5]), {align:'right', mono:true, weight:'600'}),
          cell(r[6], {align:'center', badge:true, badgeBg:r[6] === 'Posted' ? '#F0EEE9' : C.warnBg, badgeFg:r[6] === 'Posted' ? '#3D3A36' : C.warn})]})))};
  }

  inv() {
    const S = this.state, t = S.invTab;
    let rows = [];
    if (t !== 'dealer') rows = rows.concat(S.batches.map(b => ({kind:'crop', name:b.crop, sub:'Batch ' + b.id + ' · ' + b.grade, wh:b.wh, qty:b.rem, unit:'MT', cost:b.cost, val:b.rem * b.cost, age:b.age, date:b.date, low:b.age > 60})));
    if (t !== 'crop') rows = rows.concat(this.data.products.map(p => ({kind:'dealer', name:p.name, sub:p.brand + ' · ' + p.cat, wh:'Bogura Depot', qty:p.stock, unit:p.unit, cost:p.pur, val:p.stock * p.pur, age:null, date:'—', low:p.stock < p.min})));
    const sort = S.invSort;
    rows.sort((a, b) => sort === 'value' ? b.val - a.val : sort === 'age' ? (b.age || 0) - (a.age || 0) : sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
    const mark = k => sort === k ? '  ↓' : '';
    const total = rows.reduce((t2, r) => t2 + r.val, 0);
    return {tabs:[{k:'all', l:'All stock'}, {k:'crop', l:'Bulk crops'}, {k:'dealer', l:'Dealer products'}].map(x => ({l:x.l, on:x.k === t,
        bg:x.k === t ? '#fff' : 'transparent', color:x.k === t ? C.ink : C.mut, onClick:this.hs('invTab', x.k)})),
      kpis:[{k:'Total stock value', v:money(24360000), s:'across 4 warehouses'}, {k:'Bulk crop stock', v:'365 MT', s:money(18740000)}, {k:'Dealer product stock', v:'3,842 units', s:money(5620000)}, {k:'Low stock / dead stock', v:'3 items', s:'needs action'}],
      table:table([column('Item', 'left', {onClick:this.hs('invSort', 'name'), sortMark:mark('name')}), column('Type'), column('Warehouse'),
        column('Quantity', 'right', {onClick:this.hs('invSort', 'qty'), sortMark:mark('qty')}), column('Avg cost', 'right'),
        column('Stock value', 'right', {onClick:this.hs('invSort', 'value'), sortMark:mark('value')}),
        column('Age', 'right', {onClick:this.hs('invSort', 'age'), sortMark:mark('age')}), column('Status', 'center')],
        rows.map(r => ({cells:[cell(r.name, {weight:'600', sub:r.sub}),
          cell(r.kind === 'crop' ? 'Bulk Crop' : 'Dealer', {badge:true, badgeBg:r.kind === 'crop' ? C.cropBg : C.dealBg, badgeFg:r.kind === 'crop' ? C.crop : C.deal}),
          cell(r.wh, {color:C.mut}), cell(dec2(r.qty) + ' ' + r.unit, {align:'right', mono:true, weight:'600'}),
          cell(money(r.cost), {align:'right', mono:true}), cell(money(r.val), {align:'right', mono:true, weight:'600'}),
          cell(r.age === null ? '—' : r.age + ' d', {align:'right', mono:true, color:r.age > 60 ? C.dngr : C.mut, sub:r.date}),
          cell(r.low ? (r.kind === 'crop' ? 'Ageing' : 'Low stock') : 'Healthy', {align:'center', badge:true, badgeBg:r.low ? C.warnBg : C.cropBg, badgeFg:r.low ? C.warn : C.crop})]})),
        {footNote:rows.length + ' stock lines · valuation ' + S.valuation, footTotal:'Total ' + money(total)})};
  }

  cust() {
    const S = this.state, all = this.custList(), c = all.filter(x => x.code === S.custSel)[0] || all[0];
    const avail = c.limit - c.out;
    const purchases = table([column('Invoice'), column('Date'), column('Items'), column('Amount', 'right'), column('Paid', 'right'), column('Due', 'right'), column('Status', 'center')],
      [['DS-2608-221', '28 Aug 2026', '4 items', 1328000, 400000, 928000, 'Pending approval'], ['DS-2608-204', '21 Aug 2026', '6 items', 862000, 862000, 0, 'Settled'],
       ['DS-2608-188', '14 Aug 2026', '3 items', 445000, 245000, 200000, 'Partial'], ['DS-2607-171', '31 Jul 2026', '5 items', 738000, 738000, 0, 'Settled']].map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(money(r[3]), {align:'right', mono:true}),
        cell(money(r[4]), {align:'right', mono:true, color:C.crop}), cell(money(r[5]), {align:'right', mono:true, weight:'600', color:r[5] ? C.dngr : C.mut}),
        cell(r[6], {align:'center', badge:true, badgeBg:r[6] === 'Settled' ? C.cropBg : r[6] === 'Partial' ? C.warnBg : '#F0EEE9', badgeFg:r[6] === 'Settled' ? C.crop : r[6] === 'Partial' ? C.warn : '#3D3A36'})]})));
    const payments = table([column('Receipt'), column('Date'), column('Mode'), column('Against invoice'), column('Amount', 'right')],
      [['RC-2608-309', '27 Aug 2026', 'bKash', 'DS-2608-221', 400000], ['RC-2608-291', '21 Aug 2026', 'Bank — Islami Bank', 'DS-2608-204', 862000],
       ['RC-2608-266', '14 Aug 2026', 'Cash', 'DS-2608-188', 245000], ['RC-2607-240', '31 Jul 2026', 'Cheque', 'DS-2607-171', 738000]].map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3], {mono:true, color:C.mut}),
        cell(money(r[4]), {align:'right', mono:true, weight:'600', color:C.crop})]})));
    const ledger = table([column('Date'), column('Particulars'), column('Debit', 'right'), column('Credit', 'right'), column('Balance', 'right')],
      [['31 Jul 2026', 'Opening balance', 0, 0, 282000], ['14 Aug 2026', 'Invoice DS-2608-188', 445000, 0, 727000], ['14 Aug 2026', 'Receipt RC-2608-266', 0, 245000, 482000],
       ['21 Aug 2026', 'Invoice DS-2608-204', 862000, 0, 1344000], ['21 Aug 2026', 'Receipt RC-2608-291', 0, 862000, 482000],
       ['28 Aug 2026', 'Invoice DS-2608-221', 1328000, 0, 1810000], ['27 Aug 2026', 'Receipt RC-2608-309', 0, 400000, 1410000]].map(r => ({cells:[
        cell(r[0], {color:C.mut}), cell(r[1]), cell(r[2] ? money(r[2]) : '—', {align:'right', mono:true}),
        cell(r[3] ? money(r[3]) : '—', {align:'right', mono:true}), cell(money(r[4]), {align:'right', mono:true, weight:'600'})]})));
    return {list:all.map(x => ({code:x.code, name:x.name, bn:x.bn, meta:x.type + ' · ' + x.district, out:money(x.out),
      on:x.code === S.custSel, bg:x.code === S.custSel ? C.accBg : '#fff', bd:x.code === S.custSel ? C.acc : '#E3E0DA', onClick:this.hs('custSel', x.code)})),
      c:c, salesText:money(c.sales), collText:money(c.coll), outText:money(c.out), limitText:money(c.limit), availText:money(avail),
      availW:Math.min(100, c.out / c.limit * 100).toFixed(1) + '%', availColor:avail < 0 ? C.dngr : C.crop, daysText:c.days + ' days',
      tabs:this.tabify([{k:'purchases', l:'Purchase history'}, {k:'payments', l:'Payment history'}, {k:'ledger', l:'Ledger'}], S.custTab, 'custTab'),
      isPur:S.custTab === 'purchases', isPay:S.custTab === 'payments', isLed:S.custTab === 'ledger',
      purchases:purchases, payments:payments, ledger:ledger};
  }

  sup() {
    const S = this.state, s = this.data.suppliers.filter(x => x.code === S.supSel)[0] || this.data.suppliers[0];
    const pur = table([column('Purchase No'), column('Date'), column('Crop'), column('Batch'), column('Qty', 'right'), column('Rate', 'right'), column('Amount', 'right'), column('Paid', 'right')],
      this.state.cropLog.filter(r => r.sup === s.name).concat(this.state.cropLog.slice(0, 2)).slice(0, 4).map((r, i) => ({cells:[
        cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.crop, {dot:C.crop}),
        cell('BC-2608-0' + (11 - i), {mono:true, color:C.mut}), cell(int(r.qty) + ' ' + r.unit, {align:'right', mono:true}),
        cell(money(r.rate), {align:'right', mono:true}), cell(money(r.total), {align:'right', mono:true, weight:'600'}),
        cell(money(r.total * (i === 0 ? 0.5 : 1)), {align:'right', mono:true, color:C.crop})]})),
      {emptyTitle:'No purchases from this supplier yet', emptyNote:'Post a bulk crop purchase to see the history here.'});
    const pay = table([column('Voucher'), column('Date'), column('Mode'), column('Against'), column('Amount', 'right')],
      [['PY-2608-118', '27 Aug 2026', 'bKash', 'PC-2608-013 advance', 1500000], ['PY-2608-104', '22 Aug 2026', 'Bank — DBBL', 'PC-2608-013 balance', 1060000],
       ['PY-2608-090', '18 Aug 2026', 'Cash', 'PC-2608-009', 800000]].map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3], {color:C.mut}),
        cell(money(r[4]), {align:'right', mono:true, weight:'600', color:C.dngr})]})));
    return {list:this.data.suppliers.map(x => ({code:x.code, name:x.name, bn:x.bn, meta:x.type + ' · ' + x.upazila + ', ' + x.district, out:money(x.out),
      on:x.code === S.supSel, bg:x.code === S.supSel ? C.accBg : '#fff', bd:x.code === S.supSel ? C.acc : '#E3E0DA', onClick:this.hs('supSel', x.code)})),
      s:s, purText:money(s.pur), paidText:money(s.paid), outText:money(s.out),
      tabs:this.tabify([{k:'purchases', l:'Purchase history'}, {k:'payments', l:'Payment history'}], S.supTab, 'supTab'),
      isPur:S.supTab === 'purchases', purchases:pur, payments:pay};
  }

  acct() {
    const S = this.state, t = S.acctTab;
    const rec = table([column('Customer'), column('Type'), column('Credit limit', 'right'), column('0–30', 'right'), column('31–60', 'right'), column('61–90', 'right'), column('90+', 'right'), column('Total due', 'right'), column('', 'center')],
      this.data.customers.map(c => ({cells:[cell(c.name, {weight:'600', sub:c.district}), cell(c.type, {color:C.mut}),
        cell(money(c.limit), {align:'right', mono:true, color:C.mut}), cell(money(c.b30), {align:'right', mono:true}),
        cell(money(c.b60), {align:'right', mono:true, color:c.b60 ? C.warn : C.mut}),
        cell(money(c.b90), {align:'right', mono:true, color:c.b90 ? '#C4720F' : C.mut}),
        cell(money(c.b90p), {align:'right', mono:true, color:c.b90p ? C.dngr : C.mut, weight:c.b90p ? '600' : '400'}),
        cell(money(c.out), {align:'right', mono:true, weight:'700'}),
        cell('Collect', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]})),
      {footNote:'6 customers with open balance', footTotal:'Receivable ' + money(this.data.customers.reduce((x, c) => x + c.out, 0))});
    const pay = table([column('Party'), column('Kind'), column('Bill / reference'), column('Due date'), column('Outstanding', 'right'), column('', 'center')],
      this.data.suppliers.filter(s => s.out > 0).map(s => ({cells:[cell(s.name, {weight:'600', sub:s.district}), cell('Farmer / supplier', {badge:true, badgeBg:C.cropBg, badgeFg:C.crop}),
        cell('PC balance', {color:C.mut}), cell('30 Aug 2026', {color:C.mut}), cell(money(s.out), {align:'right', mono:true, weight:'700'}),
        cell('Pay', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))
        .concat(this.data.companies.filter(c => c.bal > 0).map(c => ({cells:[cell(c.name, {weight:'600', sub:c.district}), cell('Principal company', {badge:true, badgeBg:C.dealBg, badgeFg:C.deal}),
          cell('Invoice ' + c.code, {color:C.mut}), cell('05 Sep 2026', {color:C.mut}), cell(money(c.bal), {align:'right', mono:true, weight:'700'}),
          cell('Pay', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))),
      {footNote:'Payables across farmers and companies', footTotal:'Payable ' + money(4030000)});
    const cash = table([column('Account'), column('Type'), column('Last movement'), column('Balance', 'right')],
      [['Office cash — Bogura', 'Cash', '28 Aug 2026', 385000], ['Islami Bank — 20501...4417', 'Bank', '28 Aug 2026', 2140000],
       ['DBBL — 1471...8802', 'Bank', '27 Aug 2026', 1520000], ['bKash Merchant — 01755...', 'MFS', '28 Aug 2026', 240000]].map(r => ({cells:[
        cell(r[0], {weight:'600'}), cell(r[1], {badge:true, badgeBg:'#F0EEE9', badgeFg:'#3D3A36'}), cell(r[2], {color:C.mut}),
        cell(money(r[3]), {align:'right', mono:true, weight:'700'})]})), {footNote:'4 accounts', footTotal:'Total ' + money(4285000)});
    const exp = table([column('Voucher'), column('Date'), column('Category'), column('Note'), column('Business'), column('Amount', 'right')],
      [['EXP-2608-118', '27 Aug', 'Transport', 'Dinajpur → Bogura, 3 trucks', 'crop', 96000], ['EXP-2608-112', '26 Aug', 'Loading / Unloading', 'Naogaon godown labour', 'crop', 34000],
       ['EXP-2608-108', '25 Aug', 'Salary', 'August advance — 4 staff', 'both', 128000], ['EXP-2608-101', '23 Aug', 'Warehouse', 'Rangpur store rent', 'both', 45000],
       ['EXP-2608-094', '21 Aug', 'Fuel', 'Delivery van, dealer route', 'dealer', 18600], ['EXP-2608-088', '19 Aug', 'Commission', 'Aratdar commission, paddy lot', 'crop', 62500]].map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3], {color:C.mut}),
        cell(r[4] === 'crop' ? 'Bulk Crop' : r[4] === 'dealer' ? 'Dealer' : 'Shared', {badge:true, badgeBg:r[4] === 'crop' ? C.cropBg : r[4] === 'dealer' ? C.dealBg : '#F0EEE9', badgeFg:r[4] === 'crop' ? C.crop : r[4] === 'dealer' ? C.deal : '#3D3A36'}),
        cell(money(r[5]), {align:'right', mono:true, weight:'600'})]})), {footNote:'August 2026 expenses', footTotal:'Total ' + money(384100)});
    const pl = PROFIT_AND_LOSS;
    return {tabs:this.tabify([{k:'receivable', l:'Receivable'}, {k:'payable', l:'Payable'}, {k:'cash', l:'Cash & Bank'}, {k:'expense', l:'Expense'}, {k:'pl', l:'Profit & Loss'}], t, 'acctTab'),
      isRec:t === 'receivable', isPay:t === 'payable', isCash:t === 'cash', isExp:t === 'expense', isPl:t === 'pl',
      rec:rec, pay:pay, cash:cash, exp:exp,
      kpis:[{k:'Total receivable', v:money(3100000), s:'৳12.4 L overdue'}, {k:'Total payable', v:money(4030000), s:'৳6.7 L due this week'},
        {k:'Cash & bank', v:money(4285000), s:'4 accounts'}, {k:'Net profit — August', v:money(3553100), s:'margin 10.3%'}],
      pl:pl.map(x => ({k:x.k, v:money(x.v), bold:x.bold ? '600' : '400', size:x.big ? '17px' : '13.5px',
        color:x.good ? C.crop : x.v < 0 ? '#3D3A36' : C.ink, bg:x.bold ? '#FAF9F7' : '#fff'}))};
  }

  rep() {
    const S = this.state;
    const groups = REPORT_GROUPS;
    const defs = {
      'crop-batch-profit':{title:'Batch-wise crop profit', note:'August 2026 · all warehouses · bulk crop only',
        t:table([column('Batch'), column('Crop'), column('Supplier'), column('Purchased', 'right'), column('Sold', 'right'), column('Landed cost', 'right'), column('Avg sale rate', 'right'), column('Profit / MT', 'right'), column('Total profit', 'right')],
          [['BC-2608-011', 'Maize', 'Abdul Karim Mondol', 100, 38, 30800, 34500, 3700, 140600], ['BC-2608-009', 'Maize', 'Aftab Ali Bepari', 60, 25, 29450, 33200, 3750, 93750],
           ['BC-2607-014', 'Paddy (BRRI-28)', 'Jashim Uddin Sarkar', 250, 162, 26200, 28900, 2700, 437400], ['BC-2607-008', 'Rice (Miniket)', 'Jashim Uddin Sarkar', 120, 75, 57400, 61500, 4100, 307500],
           ['BC-2607-002', 'Potato', 'Nurul Haque Krishi Khamar', 180, 84, 20900, 22600, 1700, 142800], ['BC-2606-001', 'Onion', 'Shahida Begum', 40, 26, 45800, 44200, -1600, -41600]].map(r => ({cells:[
            cell(r[0], {mono:true, weight:'600'}), cell(r[1], {dot:C.crop}), cell(r[2], {color:C.mut}),
            cell(int(r[3]) + ' MT', {align:'right', mono:true}), cell(int(r[4]) + ' MT', {align:'right', mono:true}),
            cell(money(r[5]), {align:'right', mono:true}), cell(money(r[6]), {align:'right', mono:true}),
            cell(money(r[7]), {align:'right', mono:true, color:Number(r[7]) < 0 ? C.dngr : C.crop}),
            cell(money(r[8]), {align:'right', mono:true, weight:'700', color:Number(r[8]) < 0 ? C.dngr : C.crop})]})),
          {footNote:'6 batches', footTotal:'Total profit ' + money(1080450)})},
      'fin-aging':{title:'Customer outstanding & aging', note:'As on 28 Aug 2026 · dealer business', t:this.acct().rec},
      'sales-product':{title:'Product-wise sales', note:'August 2026 · dealer business',
        t:table([column('Product'), column('Category'), column('Qty sold', 'right'), column('Sales value', 'right'), column('Cost', 'right'), column('Profit', 'right'), column('Margin', 'right')],
          this.data.products.map((p, i) => { const q = [1420, 760, 380, 510, 96, 132][i], sv = q * p.sale, c = q * p.pur;
            return {cells:[cell(p.name, {weight:'600'}), cell(p.cat, {color:C.mut}), cell(int(q) + ' ' + p.unit, {align:'right', mono:true}),
              cell(money(sv), {align:'right', mono:true, weight:'600'}), cell(money(c), {align:'right', mono:true, color:C.mut}),
              cell(money(sv - c), {align:'right', mono:true, color:C.crop, weight:'600'}), cell(((sv - c) / sv * 100).toFixed(1) + '%', {align:'right', mono:true})]}; }),
          {footNote:'6 products', footTotal:'Sales ' + money(1738020)})},
      'pur-supplier':{title:'Supplier-wise purchase', note:'FY 2026-27 to date · bulk crop',
        t:table([column('Supplier'), column('Type'), column('District'), column('Purchase value', 'right'), column('Paid', 'right'), column('Outstanding', 'right')],
          this.data.suppliers.map(s => ({cells:[cell(s.name, {weight:'600', sub:s.bn}), cell(s.type, {color:C.mut}), cell(s.district), cell(money(s.pur), {align:'right', mono:true, weight:'600'}),
            cell(money(s.paid), {align:'right', mono:true, color:C.crop}), cell(money(s.out), {align:'right', mono:true, weight:'600', color:s.out ? C.dngr : C.mut})]})),
          {footNote:'5 suppliers', footTotal:'Purchase ' + money(33510000)})}
    };
    const cur = defs[S.repSel];
    const flat = []; groups.forEach(g => g.items.forEach(i => flat.push({id:i[0], l:i[1]})));
    const curLabel = (flat.filter(f => f.id === S.repSel)[0] || {l:''}).l;
    return {groups:groups.map(g => ({g:g.g, items:g.items.map(i => ({l:i[1], on:i[0] === S.repSel, bg:i[0] === S.repSel ? C.accBg : 'transparent',
      color:i[0] === S.repSel ? C.acc : '#3D3A36', weight:i[0] === S.repSel ? '600' : '400',
      onClick:() => { this.setState({repSel:i[0], repLoading:true}); clearTimeout(this._r); this._r = setTimeout(() => this.setState({repLoading:false}), 550); }}))})),
      loading:S.repLoading, has:!!cur && !S.repLoading, none:!cur && !S.repLoading,
      title:cur ? cur.title : curLabel, note:cur ? cur.note : 'This report is wired to the same filter engine but has no seeded rows in the prototype.',
      t:cur ? cur.t : table([], []), curLabel:curLabel,
      onExport:() => this.fire(curLabel + ' exported to Excel (.xlsx)', 'ok'), onPdf:() => this.fire(curLabel + ' exported to PDF', 'ok')};
  }

  appr() {
    const S = this.state, L = this.limit();
    const act = (id, ok) => () => {
      const history = (ok ? 'Approved' : 'Rejected') + ' by ' + this.data.company.user + ' · 28 Aug, just now';
      this.persist('decideApproval', id, ok, history).then(() => {
        this.setState(s => ({approvals:s.approvals.map(a => a.id === id ? Object.assign({}, a, {status:ok ? 'approved' : 'rejected', hist:history}) : a)}));
        this.fire('Request ' + id + ' ' + (ok ? 'approved' : 'rejected'), ok ? 'ok' : 'warn');
      }).catch(err => { if (!err.silent) this.fire('Could not record decision — ' + err.message, 'danger'); });
    };
    const cards = S.approvals.filter(a => a.status === 'pending').map(a => ({id:a.id, kind:a.kind, ref:a.ref, party:a.party, amt:money(a.amt), by:a.by, when:a.when, why:a.why,
      tone:a.kind.indexOf('Crop') > -1 ? C.crop : a.kind === 'Sales Discount' ? C.deal : C.warn,
      toneBg:a.kind.indexOf('Crop') > -1 ? C.cropBg : a.kind === 'Sales Discount' ? C.dealBg : C.warnBg,
      onOk:act(a.id, true), onNo:act(a.id, false)}));
    const done = S.approvals.filter(a => a.status !== 'pending');
    return {cards:cards, empty:cards.length === 0, count:cards.length, limitText:money(L),
      hist:table([column('Request'), column('Type'), column('Reference'), column('Party'), column('Amount', 'right'), column('Outcome'), column('History')],
        done.map(a => ({cells:[cell(a.id, {mono:true, weight:'600'}), cell(a.kind), cell(a.ref, {mono:true, color:C.mut}), cell(a.party),
          cell(money(a.amt), {align:'right', mono:true, weight:'600'}),
          cell(a.status === 'approved' ? 'Approved' : 'Rejected', {badge:true, badgeBg:a.status === 'approved' ? C.cropBg : '#FBEEF0', badgeFg:a.status === 'approved' ? C.crop : C.dngr}),
          cell(a.hist, {color:C.mut, size:'12px'})]})), {emptyTitle:'No decisions yet', emptyNote:'Approved and rejected requests will be listed here.'})};
  }

  search() {
    const q = this.state.q.trim().toLowerCase();
    if (!q) return {open:false, groups:[], q:q, empty:false};
    const hit = [];
    this.custList().forEach(c => { if ((c.name + c.code + c.district + c.mobile).toLowerCase().indexOf(q) > -1) hit.push({g:'Customers', l:c.name, s:c.code + ' · ' + c.district + ' · due ' + money(c.out), go:'customers', pick:['custSel', c.code]}); });
    this.data.suppliers.forEach(c => { if ((c.name + c.code + c.district + c.mobile).toLowerCase().indexOf(q) > -1) hit.push({g:'Suppliers', l:c.name, s:c.code + ' · ' + c.district + ' · payable ' + money(c.out), go:'suppliers', pick:['supSel', c.code]}); });
    this.data.companies.forEach(c => { if ((c.name + c.code + c.type).toLowerCase().indexOf(q) > -1) hit.push({g:'Companies', l:c.name, s:c.code + ' · ' + c.type, go:'companies', pick:null}); });
    this.data.products.forEach(p => { if ((p.name + p.code + p.brand + p.cat).toLowerCase().indexOf(q) > -1) hit.push({g:'Products', l:p.name, s:p.code + ' · stock ' + int(p.stock) + ' ' + p.unit + ' · sale ' + money(p.sale), go:'inventory', pick:null}); });
    this.state.batches.forEach(b => { if ((b.id + b.crop + b.wh).toLowerCase().indexOf(q) > -1) hit.push({g:'Batches', l:b.id + ' — ' + b.crop, s:b.rem + ' MT left · cost ' + money(b.cost) + ' · ' + b.wh, go:'inventory', pick:null}); });
    this.state.cropLog.forEach(r => { if ((r.no + r.sup + r.crop).toLowerCase().indexOf(q) > -1) hit.push({g:'Crop purchases', l:r.no, s:r.sup + ' · ' + r.crop + ' · ' + money(r.total) + ' · ' + r.status, go:'crop-purchase', pick:null}); });
    this.state.saleLog.forEach(r => { if ((r.no + r.buyer + r.crop + r.batch).toLowerCase().indexOf(q) > -1) hit.push({g:'Crop sales', l:r.no, s:r.buyer + ' · ' + r.crop + ' · ' + money(r.amt), go:'crop-sales', pick:null}); });
    const gs = [];
    hit.slice(0, 14).forEach(h => { let g = gs.filter(x => x.g === h.g)[0]; if (!g) { g = {g:h.g, items:[]}; gs.push(g); }
      g.items.push({l:h.l, s:h.s, onClick:() => { const st = {screen:h.go, q:'', qOpen:false}; if (h.pick) st[h.pick[0]] = h.pick[1]; this.setState(st); }}); });
    return {open:true, groups:gs, q:this.state.q, empty:gs.length === 0};
  }

  renderVals() {
    const S = this.state, role = this.role();
    const nav = this.data.nav.map(g => ({g:g.g, items:g.items.filter(i => i.roles === '*' || i.roles.indexOf(role) > -1).map(i => ({
      label:i.label, icon:i.icon, on:S.screen === i.id, onClick:this.go(i.id),
      bg:S.screen === i.id ? C.accBg : 'transparent', color:S.screen === i.id ? C.acc : '#4A463F',
      weight:S.screen === i.id ? '600' : '450', barBg:S.screen === i.id ? C.acc : 'transparent'}))})).filter(g => g.items.length);
    const title = this.data.titles[S.screen] || ['', ''];
    const is = {}; Object.keys(this.data.titles).forEach(k => { is[k.split('-').join('')] = S.screen === k; });
    const pendCount = S.approvals.filter(a => a.status === 'pending').length;
    const empSet = EMPLOYEES;
    return {
      co:this.data.company, role:role, biz:S.biz, screen:S.screen, titleMain:title[0], titleSub:title[1], is:is,
      bizTabs:[{k:'all', l:'All business'}, {k:'dealer', l:'Dealer'}, {k:'crop', l:'Bulk Crop'}].map(x => ({l:x.l, on:x.k === S.biz,
        bg:x.k === S.biz ? '#fff' : 'transparent', color:x.k === S.biz ? C.ink : C.mut, sh:x.k === S.biz ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
        onClick:() => { this.setState({biz:x.k}); this.loadDashboard(); }})),
      nav:nav, dash:this.dash(), cp:this.calcCP(), cs:this.calcCS(), ds:this.calcDS(), dp:this.calcDP(),
      inv:this.inv(), cust:this.cust(), sup:this.sup(), acct:this.acct(), rep:this.rep(), appr:this.appr(),
      sr:this.search(), q:S.q, onQ:e => this.setState({q:e.target.value, qOpen:true}), onQClear:() => this.setState({q:'', qOpen:false}),
      notifOpen:S.notifOpen, onNotif:() => this.setState(s => ({notifOpen:!s.notifOpen, userOpen:false})), notifCount:S.notifs.length,
      notifs:S.notifs.map(n => ({t:n.t, d:n.d, ago:n.ago, onClick:this.go(n.go),
        c:n.tone === 'danger' ? C.dngr : n.tone === 'warn' ? C.warn : n.tone === 'ok' ? C.crop : C.acc})),
      userOpen:S.userOpen, onUser:() => this.setState(s => ({userOpen:!s.userOpen, notifOpen:false})),
      toast:S.toast, toastBg:S.toast ? (S.toast.tone === 'danger' ? '#B3261E' : S.toast.tone === 'warn' ? '#8A5A00' : '#1F4D2E') : '#1F4D2E',
      onCloseToast:() => this.setState({toast:null}),
      pend:pendCount, pendText:pendCount + ' pending',
      onCP:{sup:this.h('cp', 'sup'), crop:this.h('cp', 'crop'), grade:this.h('cp', 'grade'), wh:this.h('cp', 'wh'), date:this.h('cp', 'date'),
        qty:this.h('cp', 'qty', true), unit:this.h('cp', 'unit'), moist:this.h('cp', 'moist', true), rate:this.h('cp', 'rate', true),
        transport:this.h('cp', 'transport', true), loading:this.h('cp', 'loading', true), unloading:this.h('cp', 'unloading', true),
        other:this.h('cp', 'other', true), advance:this.h('cp', 'advance', true), note:this.h('cp', 'note'),
        post:() => this.postCP(), draft:() => this.fire('Draft PC-2608-014 saved — nothing posted to stock or accounts', 'ok')},
      onCS:{buyer:this.h('cs', 'buyer'), crop:this.h('cs', 'crop'), date:this.h('cs', 'date'), rate:this.h('cs', 'rate', true),
        transport:this.h('cs', 'transport', true), other:this.h('cs', 'other', true), target:this.h('cs', 'target', true),
        auto:() => this.autoAlloc(), post:() => this.postCS(), clear:() => this.setState(s => ({cs:Object.assign({}, s.cs, {alloc:{}})}))},
      onNC:{name:this.h('newCust', 'name'), bn:this.h('newCust', 'bn'), type:this.h('newCust', 'type'), person:this.h('newCust', 'person'),
        mobile:this.h('newCust', 'mobile'), district:this.h('newCust', 'district'), upazila:this.h('newCust', 'upazila'),
        limit:this.h('newCust', 'limit', true), days:this.h('newCust', 'days', true), opening:this.h('newCust', 'opening', true)},
      onDS:{cust:this.h('ds', 'cust'), date:this.h('ds', 'date'), sp:this.h('ds', 'sp'), wh:this.h('ds', 'wh'), terms:this.h('ds', 'terms'), paid:this.h('ds', 'paid', true)},
      onDP:{co:this.h('dp', 'co'), inv:this.h('dp', 'inv'), date:this.h('dp', 'date'), wh:this.h('dp', 'wh'), terms:this.h('dp', 'terms'),
        transport:this.h('dp', 'transport', true), other:this.h('dp', 'other', true)},
      valTabs:[{k:'FIFO', l:'FIFO'}, {k:'Weighted Average', l:'Weighted average'}].map(x => ({l:x.l, on:x.k === S.valuation,
        bg:x.k === S.valuation ? C.accBg : '#fff', color:x.k === S.valuation ? C.acc : C.mut, bd:x.k === S.valuation ? C.acc : C.bd, onClick:this.hs('valuation', x.k)})),
      setSecs:[['company', 'Company profile'], ['fy', 'Financial year'], ['numbering', 'Numbering'], ['units', 'Units & conversion'], ['pay', 'Payment methods'],
        ['limits', 'Approval limits'], ['valuation', 'Inventory valuation'], ['roles', 'Roles & permissions'], ['notif', 'Notification rules']].map(x => ({
        l:x[1], on:S.setSec === x[0], bg:S.setSec === x[0] ? C.accBg : 'transparent', color:S.setSec === x[0] ? C.acc : '#3D3A36',
        weight:S.setSec === x[0] ? '600' : '400', onClick:this.hs('setSec', x[0])})),
      setIs:{company:S.setSec === 'company', fy:S.setSec === 'fy', numbering:S.setSec === 'numbering', units:S.setSec === 'units',
        pay:S.setSec === 'pay', limits:S.setSec === 'limits', valuation:S.setSec === 'valuation', roles:S.setSec === 'roles', notif:S.setSec === 'notif'},
      matrix: PERMISSION_MATRIX,
      emp:table([column('ID'), column('Name'), column('Designation'), column('Department'), column('Mobile'), column('System role'), column('Joined'), column('Status', 'center')],
        empSet.map(e => ({cells:[cell(e[0], {mono:true, color:C.mut}), cell(e[1], {weight:'600'}), cell(e[2]), cell(e[3], {color:C.mut}),
          cell(e[4], {mono:true}), cell(e[5], {badge:true, badgeBg:C.dealBg, badgeFg:C.deal}), cell(e[6], {color:C.mut}),
          cell('Active', {align:'center', badge:true, badgeBg:C.cropBg, badgeFg:C.crop})]})), {footNote:'10 employees · 6 departments'}),
      audit:table([column('When'), column('User'), column('Action'), column('Record'), column('Field'), column('Previous'), column('New')],
        [['28 Aug, 10:12 am', 'Sohel Rana', 'Created', 'PC-2608-014', 'Purchase', '—', '৳30,20,000'],
         ['28 Aug, 9:58 am', 'Sohel Rana', 'Edited', 'PC-2608-014', 'Transport cost', '৳42,000', '৳50,000'],
         ['28 Aug, 9:40 am', 'Shamim Reza', 'Changed rate', 'DS-2608-221', 'Sales rate — Ridomil', '৳295', '৳286'],
         ['27 Aug, 6:05 pm', 'Jamal Uddin', 'Adjusted stock', 'BC-2607-014', 'Quantity', '92 MT', '88 MT'],
         ['27 Aug, 3:22 pm', 'Nasrin Akter', 'Received payment', 'RC-2608-309', 'Amount', '—', '৳4,00,000'],
         ['26 Aug, 12:15 pm', 'Rakib Hasan', 'Approved', 'SC-2608-051', 'Status', 'Pending approval', 'Approved'],
         ['26 Aug, 11:50 am', 'Shamim Reza', 'Posted', 'SC-2608-051', 'Status', 'Draft', 'Pending approval'],
         ['25 Aug, 5:02 pm', 'Rakib Hasan', 'Rejected', 'DS-2608-198', 'Discount', '8%', 'Rejected']].map(r => ({cells:[
          cell(r[0], {color:C.mut, mono:true, size:'12px'}), cell(r[1], {weight:'600'}), cell(r[2]), cell(r[3], {mono:true, color:C.mut}),
          cell(r[4]), cell(r[5], {mono:true, color:C.mut}), cell(r[6], {mono:true, weight:'600'})]})), {maxH:'520px'}),
      repFilters:[{k:'Period', v:'01–28 Aug 2026'}, {k:'Business type', v:S.biz === 'all' ? 'All' : S.biz === 'crop' ? 'Bulk Crop' : 'Dealer'},
        {k:'Warehouse', v:'All'}, {k:'Customer', v:'All'}, {k:'Supplier', v:'All'}, {k:'Crop / product', v:'All'}, {k:'Currency', v:'BDT ৳'}],
      skeleton:[{w:'92%'}, {w:'78%'}, {w:'85%'}, {w:'64%'}, {w:'88%'}, {w:'71%'}],
      setCompany:[{k:'Company name', v:this.data.company.name}, {k:'Trade licence no', v:'BOG-TL-2019-04471'}, {k:'BIN / VAT registration', v:'003912847-0201'},
        {k:'Head office', v:'Sherpur Road, Bogura Sadar, Bogura'}, {k:'Mobile', v:'01711-330099'}, {k:'Email', v:'accounts@meghnaagro.com.bd'},
        {k:'Currency', v:'Bangladeshi Taka (৳)'}, {k:'Default district', v:'Bogura'}],
      setFy: FINANCIAL_YEARS,
      setNum: NUMBERING,
      setUnits: UNIT_CONVERSIONS,
      setPay: PAYMENT_METHODS
        .map(p => ({k:p.k, d:p.d, tone:p.on ? C.crop : '#D9D5CD', knob:p.on ? '19px' : '2px'})),
      setLimits:[{k:'Purchase requiring approval above', v:money(this.limit())}, {k:'Sales discount ceiling', v:'5.00%'},
        {k:'Expense requiring approval above', v:money(50000)}, {k:'Stock adjustment', v:'always requires approval'},
        {k:'Credit sale above customer limit', v:'always requires approval'}],
      setNotif: NOTIFICATION_RULES,
      phones: PHONE_SCREENS,
      companiesTable:table([column('Code'), column('Company'), column('Role'), column('Contact person'), column('Mobile'), column('Credit limit', 'right'), column('Balance', 'right'), column('Status', 'center')],
        this.data.companies.map(c => ({cells:[cell(c.code, {mono:true, color:C.mut}), cell(c.name, {weight:'600', sub:c.district}),
          cell(c.type, {badge:true, badgeBg:c.type === 'Buyer' ? C.cropBg : c.type === 'Principal' ? C.dealBg : '#F0EEE9', badgeFg:c.type === 'Buyer' ? C.crop : c.type === 'Principal' ? C.deal : '#3D3A36'}),
          cell(c.person), cell(c.mobile, {mono:true}), cell(c.limit ? money(c.limit) : '—', {align:'right', mono:true, color:C.mut}),
          cell((c.bal < 0 ? 'Receivable ' : 'Payable ') + money(Math.abs(c.bal)), {align:'right', mono:true, weight:'600', color:c.bal < 0 ? C.crop : C.ink}),
          cell(c.status, {align:'center', badge:true, badgeBg:c.status === 'Active' ? C.cropBg : C.warnBg, badgeFg:c.status === 'Active' ? C.crop : C.warn})]})),
        {footNote:'7 companies · one company can act as both supplier and buyer'})
    };
  }
}
