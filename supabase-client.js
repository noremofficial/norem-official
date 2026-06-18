// Supabase クライアント設定
const SUPABASE_URL  = 'https://uuhmrzkuyqxhxfzdlmsj.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1aG1yemt1eXF4aHhmemRsbXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NTEyMzAsImV4cCI6MjA5NjIyNzIzMH0.KAgns_dvBDQh1RI3YaYrAX0e1m_Mrt7MdJd_Knh6yE0';

// Supabase JS SDK（CDN経由）
// このファイルを読み込む前に supabase-js を読み込んでください:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

let _supabase = null;

function getSupabase() {
  if (!_supabase && typeof supabase !== 'undefined') {
    _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _supabase;
}

// ── 認証 ──────────────────────────────────────────
async function sbSignUp(email, password, fullName) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { full_name: fullName } }
  });
  return { data, error };
}

async function sbSignIn(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  return { data, error };
}

async function sbSignOut() {
  const sb = getSupabase();
  await sb.auth.signOut();
}

async function sbGetUser() {
  const sb = getSupabase();
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

// ── 注文保存 ──────────────────────────────────────
async function sbSaveOrder(orderData) {
  const sb   = getSupabase();
  const user = await sbGetUser();
  const { data, error } = await sb.from('orders').insert({
    user_id:        user?.id || null,
    email:          orderData.email,
    full_name:      orderData.fullName,
    postal_code:    orderData.zip,
    prefecture:     orderData.pref,
    city:           orderData.city,
    address:        orderData.addr,
    items:          orderData.cart,
    subtotal:       orderData.subtotal,
    shipping:       orderData.shipping,
    total:          orderData.subtotal + orderData.shipping,
    payment_method: orderData.payMethod,
    bespoke_payment: orderData.bespokePayment || null,
    status:         'pending',
  }).select().single();
  return { data, error };
}

// ── プロフィール更新（注文時に住所・名前を保存）──────
async function sbUpdateProfile(data) {
  const sb   = getSupabase();
  const user = await sbGetUser();
  if (!user) { console.warn('sbUpdateProfile: ユーザー未ログイン'); return; }

  const payload = {
    id:            user.id,
    email:         user.email,
    full_name:     data.fullName     || null,
    postal_code:   data.postalCode   || null,
    prefecture:    data.prefecture   || null,
    city:          data.city         || null,
    address:       data.address      || null,
    email_contact: data.emailContact || null,
  };
  console.log('プロフィール保存データ:', payload);

  const { data: result, error } = await sb
    .from('profiles')
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();

  if (error) console.error('プロフィール保存エラー:', error.message);
  else       console.log('プロフィール保存成功:', result);
  return result;
}

// ── プロフィール取得 ──────────────────────────────
async function sbGetProfile() {
  const sb   = getSupabase();
  const user = await sbGetUser();
  if (!user) return null;
  const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  return data;
}

// ── 注文履歴取得 ──────────────────────────────────
async function sbGetMyOrders() {
  const sb   = getSupabase();
  const user = await sbGetUser();
  if (!user) return { data: [], error: null };
  const { data, error } = await sb.from('orders')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return { data, error };
}
