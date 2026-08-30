import { field, formModal } from '../components/formModal.js';

/**
 * Master data forms: crops, products, customers, suppliers and companies.
 *
 * Same shape as `transactionForms.js` -- each entity is described once and the
 * modal is built from the description, so every master screen shares one form,
 * one validator and one submit path rather than a copy each.
 *
 * The lists an operator picks from (party types, districts, units) come from
 * the data already loaded, not from constants here. A district that exists
 * only because someone typed it into a supplier record still turns up in the
 * next form, and the app never offers a unit the server would reject.
 */

/** Options that exist in the data, plus the value being edited, sorted. */
function optionsFrom(rows, key, extra) {
  const seen = new Set();
  (rows || []).forEach((r) => {
    const v = r && r[key];
    if (v) seen.add(String(v));
  });
  if (extra) seen.add(String(extra));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The party types on offer.
 *
 * Seeded from what the data already uses so the list reflects this business,
 * with a small set of common ones so a first-ever record still has something
 * to choose from.
 */
const SEED_TYPES = {
  customer: ['Dealer', 'Retailer', 'Corporate', 'Individual'],
  supplier: ['Farmer', 'Aratdar', 'Trader', 'Farm'],
};

const COMPANY_ROLES = [
  { value: 'PRINCIPAL', label: 'Principal' },
  { value: 'SUPPLIER', label: 'Supplier' },
  { value: 'BUYER', label: 'Buyer' },
  { value: 'SUPPLIER_AND_BUYER', label: 'Supplier and buyer' },
];

export const MASTER_KINDS = ['crop', 'product', 'customer', 'supplier', 'company'];

const TITLES = {
  crop: ['crop', 'Crops are what the bulk trading side buys, stores and sells'],
  product: ['product', 'Agrochemicals, fertiliser, seed and feed sold through dealers'],
  customer: ['customer', 'Dealers, retailers and corporate buyers'],
  supplier: ['supplier', 'Farmers, aratdars and traders you buy from'],
  company: ['company', 'Principals, supplier companies and buyer companies'],
};

/** The empty form for a new record, or the values of the one being edited. */
export function defaultsFor(kind, data, row) {
  const districts = optionsFrom(
    (data.customers || []).concat(data.suppliers || []),
    'district'
  );
  const firstDistrict = districts[0] || '';

  if (kind === 'crop') {
    return {
      name: row ? row.name : '',
      unit: row ? row.unit || (data.units || [])[0] : (data.units || [])[0] || 'MT',
      rate: row ? row.rate : '',
    };
  }

  if (kind === 'product') {
    return {
      name: row ? row.name : '',
      cat: row ? row.cat : optionsFrom(data.products, 'cat')[0] || '',
      brand: row ? row.brand : optionsFrom(data.products, 'brand')[0] || '',
      unit: row ? row.unit : (data.units || [])[0] || 'Pcs',
      pur: row ? row.pur : '',
      sale: row ? row.sale : '',
      min: row ? row.min : '',
    };
  }

  if (kind === 'company') {
    return {
      name: row ? row.name : '',
      role: row ? row.role || 'SUPPLIER' : 'SUPPLIER',
      person: row ? row.person : '',
      mobile: row ? row.mobile : '',
      district: row ? row.district : firstDistrict,
      limit: row ? row.limit : '',
      days: row ? row.days : '',
    };
  }

  if (kind === 'supplier') {
    return {
      name: row ? row.name : '',
      bn: row ? row.bn : '',
      type: row ? row.type : SEED_TYPES.supplier[0],
      mobile: row ? row.mobile : '',
      district: row ? row.district : firstDistrict,
      upazila: row ? row.upazila : '',
      bank: row ? row.bank : '',
      opening: row ? '' : '',
    };
  }

  return {
    name: row ? row.name : '',
    bn: row ? row.bn : '',
    type: row ? row.type : SEED_TYPES.customer[0],
    person: row ? row.person : '',
    mobile: row ? row.mobile : '',
    district: row ? row.district : firstDistrict,
    upazila: row ? row.upazila : '',
    limit: row ? row.limit : '',
    days: row ? row.days : '',
    opening: '',
  };
}

/** The fields the modal shows, in the order they read. */
export function fieldsFor(kind, form, data, on, row) {
  const districts = optionsFrom(
    (data.customers || []).concat(data.suppliers || []).concat(data.companies || []),
    'district',
    form.district
  );

  if (kind === 'crop') {
    return [
      field('name', 'Crop name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Paddy (BRRI-28)',
        wide: true,
      }),
      field('unit', 'Default unit', {
        options: data.units || [],
        value: form.unit,
        onChange: on('unit'),
        hint: 'How this crop is bought, stored and sold',
      }),
      field('rate', 'Last known rate', {
        type: 'number',
        value: form.rate,
        onChange: on('rate'),
        placeholder: '0',
        hint: 'Used as the opening suggestion on a purchase',
      }),
    ];
  }

  if (kind === 'product') {
    return [
      field('name', 'Product name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'Ridomil Gold MZ 72 WP 100g',
        wide: true,
      }),
      // Categories and brands are the ones the catalogue already uses; the
      // server refuses an unknown one rather than quietly inventing it.
      field('cat', 'Category', {
        options: optionsFrom(data.products, 'cat', form.cat),
        value: form.cat,
        onChange: on('cat'),
      }),
      field('brand', 'Brand', {
        options: optionsFrom(data.products, 'brand', form.brand),
        value: form.brand,
        onChange: on('brand'),
      }),
      field('unit', 'Unit', {
        options: data.units || [],
        value: form.unit,
        onChange: on('unit'),
      }),
      field('pur', 'Purchase rate', {
        type: 'number', value: form.pur, onChange: on('pur'), placeholder: '0',
      }),
      field('sale', 'Sale rate', {
        type: 'number', value: form.sale, onChange: on('sale'), placeholder: '0',
      }),
      field('min', 'Minimum stock', {
        type: 'number', value: form.min, onChange: on('min'), placeholder: '0',
        hint: 'Below this the product is flagged as low stock',
      }),
    ];
  }

  if (kind === 'company') {
    return [
      field('name', 'Company name', {
        value: form.name,
        onChange: on('name'),
        placeholder: 'ACI Agrochemicals Ltd.',
        wide: true,
      }),
      field('role', 'Role', {
        options: COMPANY_ROLES,
        value: form.role,
        onChange: on('role'),
        hint: 'A company can both supply and buy',
      }),
      field('person', 'Contact person', { value: form.person, onChange: on('person') }),
      field('mobile', 'Mobile', { value: form.mobile, onChange: on('mobile'), mono: true }),
      field('district', 'District', {
        options: districts,
        value: form.district,
        onChange: on('district'),
      }),
      field('limit', 'Credit limit', {
        type: 'number',
        value: form.limit,
        onChange: on('limit'),
        placeholder: '0',
      }),
      field('days', 'Credit days', {
        type: 'number',
        value: form.days,
        onChange: on('days'),
        placeholder: '0',
      }),
    ];
  }

  const isSupplier = kind === 'supplier';
  const types = optionsFrom(
    isSupplier ? data.suppliers : data.customers,
    'type',
    form.type
  );
  SEED_TYPES[kind].forEach((t) => {
    if (types.indexOf(t) === -1) types.push(t);
  });
  types.sort((a, b) => a.localeCompare(b));

  const common = [
    field('name', 'Name', {
      value: form.name,
      onChange: on('name'),
      placeholder: isSupplier ? 'Abdul Karim Mondol' : 'Messrs. Rahman Traders',
      wide: true,
    }),
    field('bn', 'Name in Bangla', {
      value: form.bn,
      onChange: on('bn'),
      placeholder: 'ঐচ্ছিক',
      wide: true,
    }),
    field('type', isSupplier ? 'Supplier type' : 'Customer type', {
      options: types,
      value: form.type,
      onChange: on('type'),
    }),
    field('mobile', 'Mobile', {
      value: form.mobile,
      onChange: on('mobile'),
      mono: true,
      placeholder: '017XXXXXXXX',
    }),
    field('district', 'District', {
      options: districts,
      value: form.district,
      onChange: on('district'),
    }),
    field('upazila', 'Upazila', { value: form.upazila, onChange: on('upazila') }),
  ];

  if (isSupplier) {
    common.push(
      field('bank', 'Bank account', {
        value: form.bank,
        onChange: on('bank'),
        mono: true,
        placeholder: 'Optional',
      })
    );
  } else {
    common.push(
      field('limit', 'Credit limit', {
        type: 'number',
        value: form.limit,
        onChange: on('limit'),
        placeholder: '0',
      }),
      field('days', 'Credit days', {
        type: 'number',
        value: form.days,
        onChange: on('days'),
        placeholder: '0',
      })
    );
  }

  // An opening balance is what the party already owed on the day they were
  // added, so it only makes sense while creating one.
  if (!row) {
    common.push(
      field('opening', 'Opening balance', {
        type: 'number',
        value: form.opening,
        onChange: on('opening'),
        placeholder: '0',
        hint: isSupplier ? 'Already payable to them' : 'Already owed by them',
      })
    );
  }

  return common;
}

/** The message to show instead of saving, or null when the form is good. */
export function validate(kind, form) {
  if (!String(form.name || '').trim()) {
    return `Enter the ${TITLES[kind][0]} name.`;
  }

  if (kind === 'crop') {
    if (!form.unit) return 'Choose the unit this crop is measured in.';
    if (Number(form.rate) < 0) return 'A rate cannot be negative.';
    return null;
  }

  if (kind === 'product') {
    if (!form.unit) return 'Choose the unit this product is sold in.';
    if (Number(form.pur) < 0 || Number(form.sale) < 0) return 'A rate cannot be negative.';
    // Not an error -- a loss leader is a real decision -- but worth saying so
    // it is not a typo that only shows up in the profit report.
    if (Number(form.sale) && Number(form.sale) < Number(form.pur)) {
      return 'The sale rate is below the purchase rate; every sale would lose money.';
    }
    return null;
  }

  if (kind !== 'company' && !String(form.mobile || '').trim()) {
    return 'Enter a mobile number — it is how the party is reached and matched.';
  }

  if (Number(form.limit) < 0) return 'A credit limit cannot be negative.';
  if (Number(form.days) < 0) return 'Credit days cannot be negative.';
  return null;
}

/** What goes to the server. */
export function payloadFor(kind, form) {
  const text = (v) => String(v ?? '').trim();
  const number = (v) => Number(v) || 0;

  if (kind === 'crop') {
    return { name: text(form.name), unit: form.unit, rate: number(form.rate) };
  }

  if (kind === 'product') {
    return {
      name: text(form.name),
      cat: text(form.cat),
      brand: text(form.brand),
      unit: form.unit,
      pur: number(form.pur),
      sale: number(form.sale),
      min: number(form.min),
    };
  }

  if (kind === 'company') {
    return {
      name: text(form.name),
      role: form.role,
      person: text(form.person),
      mobile: text(form.mobile),
      district: text(form.district),
      limit: number(form.limit),
      days: number(form.days),
    };
  }

  if (kind === 'supplier') {
    return {
      name: text(form.name),
      bn: text(form.bn),
      type: form.type,
      mobile: text(form.mobile),
      district: text(form.district),
      upazila: text(form.upazila),
      bank: text(form.bank),
      opening: number(form.opening),
    };
  }

  return {
    name: text(form.name),
    bn: text(form.bn),
    type: form.type,
    person: text(form.person),
    mobile: text(form.mobile),
    district: text(form.district),
    upazila: text(form.upazila),
    limit: number(form.limit),
    days: number(form.days),
    opening: number(form.opening),
  };
}

/** Build the modal model for the master form. */
export function buildMasterModal(kind, state, data, handlers) {
  const { form, row, error, busy } = state;
  const noun = TITLES[kind][0];
  const editing = !!row;

  return formModal({
    open: true,
    title: editing ? `Edit ${noun}` : `New ${noun}`,
    subtitle: editing ? `${row.code} · ${row.name}` : TITLES[kind][1],
    fields: fieldsFor(kind, form, data, handlers.onField, row),
    error,
    busy,
    submitLabel: editing ? 'Save changes' : `Add ${noun}`,
    note: editing
      ? 'Changes apply from now on; posted documents keep the details they were posted with'
      : 'The code is allocated by the server when the record is saved',
    onSubmit: handlers.onSubmit,
    onCancel: handlers.onCancel,
  });
}
