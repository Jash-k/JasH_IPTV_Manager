import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { AppStore } from '../store/useAppStore';

interface Props { store: AppStore; }

const CORS_PROXIES = [
  { label: 'corsproxy.io', value: 'https://corsproxy.io/?' },
  { label: 'allorigins.win', value: 'https://api.allorigins.win/raw?url=' },
  { label: 'Custom', value: 'custom' },
];

export const SettingsTab: React.FC<Props> = ({ store }) => {
  const { settings, saveSettings } = store;
  const [form, setForm] = useState<Settings>(settings);
  const [customProxy, setCustomProxy] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setForm(settings); }, [settings]);

  const handleSave = async () => {
    const finalForm = { ...form };
    if (customProxy) finalForm.corsProxy = customProxy;
    await saveSettings(finalForm);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Addon Info */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg">🔌 Addon Configuration</h3>
        <div className="space-y-3">
          <div>
            <label className="text-gray-400 text-sm mb-1.5 block">Addon ID</label>
            <input value={form.addonId} onChange={e => setForm({ ...form, addonId: e.target.value })}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600" />
            <p className="text-gray-600 text-xs mt-1">Unique identifier for your Stremio addon</p>
          </div>
          <div>
            <label className="text-gray-400 text-sm mb-1.5 block">Addon Name</label>
            <input value={form.addonName} onChange={e => setForm({ ...form, addonName: e.target.value })}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600" />
          </div>
        </div>
      </div>

      {/* CORS Proxy */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg">🌐 CORS Proxy Settings</h3>
        <div className="space-y-3">
          <div>
            <label className="text-gray-400 text-sm mb-1.5 block">Select Proxy</label>
            <select value={CORS_PROXIES.find(p => p.value === form.corsProxy)?.value || 'custom'}
              onChange={e => {
                if (e.target.value !== 'custom') setForm({ ...form, corsProxy: e.target.value });
              }}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600">
              {CORS_PROXIES.map(p => <option key={p.value} value={p.value}>{p.label} — {p.value !== 'custom' ? p.value : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="text-gray-400 text-sm mb-1.5 block">Custom Proxy URL</label>
            <input value={customProxy || form.corsProxy} onChange={e => { setCustomProxy(e.target.value); setForm({ ...form, corsProxy: e.target.value }); }}
              placeholder="https://your-proxy.example.com/?url="
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600" />
          </div>
        </div>
      </div>

      {/* Stream Options */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg">⚙️ Stream Options</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-medium">Combine by Groups</div>
              <div className="text-gray-500 text-sm">Merge streams from all sources by group name</div>
            </div>
            <button onClick={() => setForm({ ...form, combineByGroups: !form.combineByGroups })}
              className={`w-12 h-7 rounded-full transition-colors relative ${form.combineByGroups ? 'bg-purple-600' : 'bg-gray-600'}`}>
              <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow ${form.combineByGroups ? 'left-6' : 'left-1'}`} />
            </button>
          </div>

          {/* ── Combine Multi-Quality ──────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-medium flex items-center gap-2">
                Combine Multi-Quality Streams
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  Recommended
                </span>
              </div>
              <div className="text-gray-500 text-sm">
                Channels with the same name+group show as one entry in Stremio with multiple quality options.
                Disable to list every stream URL separately.
              </div>
            </div>
            <button onClick={() => setForm({ ...form, combineMultiQuality: !form.combineMultiQuality })}
              className={`w-12 h-7 rounded-full transition-colors relative flex-shrink-0 ml-4 ${form.combineMultiQuality ? 'bg-blue-600' : 'bg-gray-600'}`}>
              <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow ${form.combineMultiQuality ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-medium">Auto-Remove Dead Streams</div>
              <div className="text-gray-500 text-sm">Automatically delete streams that fail health check</div>
            </div>
            <button onClick={() => setForm({ ...form, autoRemoveDead: !form.autoRemoveDead })}
              className={`w-12 h-7 rounded-full transition-colors relative ${form.autoRemoveDead ? 'bg-purple-600' : 'bg-gray-600'}`}>
              <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow ${form.autoRemoveDead ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
          <div>
            <label className="text-gray-400 text-sm mb-1.5 block">
              Health Check Interval: {form.healthCheckInterval} minutes
            </label>
            <input type="range" min={15} max={360} step={15} value={form.healthCheckInterval}
              onChange={e => setForm({ ...form, healthCheckInterval: parseInt(e.target.value) })}
              className="w-full accent-purple-500" />
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>15 min</span><span>1 hr</span><span>2 hr</span><span>6 hr</span>
            </div>
          </div>
        </div>
      </div>

      {/* Save */}
      <button onClick={handleSave}
        className={`w-full py-4 rounded-xl font-semibold text-white transition-all text-lg shadow-lg ${
          saved ? 'bg-emerald-600' : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500'
        }`}>
        {saved ? '✅ Settings Saved!' : '💾 Save Settings'}
      </button>
    </div>
  );
};
