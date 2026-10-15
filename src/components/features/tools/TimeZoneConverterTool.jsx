import { useState, useEffect } from 'react';
import { Globe, Trash2, Plus, Search } from 'lucide-react';

/**
 * Time Zone Converter Tool
 * Convert times between different time zones with pinned favorites
 */

// City coordinates for Leaflet map (actual lat/lon)
const CITY_COORDINATES = {
  // North America
  'America/New_York': { lat: 40.7, lon: -74.0 },
  'America/Chicago': { lat: 41.9, lon: -87.6 },
  'America/Denver': { lat: 39.7, lon: -105.0 },
  'America/Los_Angeles': { lat: 34.1, lon: -118.2 },
  'America/Phoenix': { lat: 33.4, lon: -112.1 },
  'America/Anchorage': { lat: 61.2, lon: -149.9 },
  'America/Toronto': { lat: 43.7, lon: -79.4 },
  'America/Vancouver': { lat: 49.3, lon: -123.1 },
  'America/Montreal': { lat: 45.5, lon: -73.6 },
  'America/Mexico_City': { lat: 19.4, lon: -99.1 },
  'Pacific/Honolulu': { lat: 21.3, lon: -157.8 },

  // South America
  'America/Sao_Paulo': { lat: -23.5, lon: -46.6 },
  'America/Rio_de_Janeiro': { lat: -22.9, lon: -43.2 },
  'America/Buenos_Aires': { lat: -34.6, lon: -58.4 },
  'America/Santiago': { lat: -33.4, lon: -70.7 },
  'America/Lima': { lat: -12.0, lon: -77.0 },
  'America/Bogota': { lat: 4.7, lon: -74.1 },

  // Europe
  'Europe/London': { lat: 51.5, lon: -0.1 },
  'Europe/Paris': { lat: 48.9, lon: 2.4 },
  'Europe/Berlin': { lat: 52.5, lon: 13.4 },
  'Europe/Rome': { lat: 41.9, lon: 12.5 },
  'Europe/Madrid': { lat: 40.4, lon: -3.7 },
  'Europe/Lisbon': { lat: 38.7, lon: -9.1 },
  'Europe/Amsterdam': { lat: 52.4, lon: 4.9 },
  'Europe/Brussels': { lat: 50.8, lon: 4.4 },
  'Europe/Vienna': { lat: 48.2, lon: 16.4 },
  'Europe/Zurich': { lat: 47.4, lon: 8.5 },
  'Europe/Prague': { lat: 50.1, lon: 14.4 },
  'Europe/Warsaw': { lat: 52.2, lon: 21.0 },
  'Europe/Budapest': { lat: 47.5, lon: 19.0 },
  'Europe/Athens': { lat: 38.0, lon: 23.7 },
  'Europe/Stockholm': { lat: 59.3, lon: 18.1 },
  'Europe/Oslo': { lat: 59.9, lon: 10.8 },
  'Europe/Copenhagen': { lat: 55.7, lon: 12.6 },
  'Europe/Helsinki': { lat: 60.2, lon: 25.0 },
  'Europe/Moscow': { lat: 55.8, lon: 37.6 },
  'Europe/Istanbul': { lat: 41.0, lon: 29.0 },
  'Europe/Kiev': { lat: 50.5, lon: 30.5 },

  // Asia
  'Asia/Dubai': { lat: 25.3, lon: 55.3 },
  'Asia/Kolkata': { lat: 22.6, lon: 88.4 },
  'Asia/Mumbai': { lat: 19.1, lon: 72.9 },
  'Asia/Delhi': { lat: 28.6, lon: 77.2 },
  'Asia/Karachi': { lat: 24.9, lon: 67.1 },
  'Asia/Dhaka': { lat: 23.8, lon: 90.4 },
  'Asia/Bangkok': { lat: 13.8, lon: 100.5 },
  'Asia/Singapore': { lat: 1.3, lon: 103.9 },
  'Asia/Jakarta': { lat: -6.2, lon: 106.8 },
  'Asia/Manila': { lat: 14.6, lon: 121.0 },
  'Asia/Hong_Kong': { lat: 22.3, lon: 114.2 },
  'Asia/Shanghai': { lat: 31.2, lon: 121.5 },
  'Asia/Beijing': { lat: 39.9, lon: 116.4 },
  'Asia/Tokyo': { lat: 35.7, lon: 139.7 },
  'Asia/Seoul': { lat: 37.6, lon: 127.0 },

  // Australia/Pacific
  'Australia/Sydney': { lat: -33.9, lon: 151.2 },
  'Australia/Melbourne': { lat: -37.8, lon: 145.0 },
  'Australia/Brisbane': { lat: -27.5, lon: 153.0 },
  'Australia/Perth': { lat: -31.9, lon: 115.9 },
  'Pacific/Auckland': { lat: -36.9, lon: 174.8 },

  // Africa
  'Africa/Cairo': { lat: 30.0, lon: 31.2 },
  'Africa/Johannesburg': { lat: -26.2, lon: 28.0 },
  'Africa/Lagos': { lat: 6.5, lon: 3.4 },
  'Africa/Nairobi': { lat: -1.3, lon: 36.8 },

  'UTC': { lat: 0, lon: 0 },
};

// Timezone to country mapping (based on CLDR/IANA database)
const TIMEZONE_COUNTRIES = {
  // Asia
  'Asia/Seoul': 'South Korea',
  'Asia/Pyongyang': 'North Korea',
  'Asia/Tokyo': 'Japan',
  'Asia/Shanghai': 'China',
  'Asia/Beijing': 'China',
  'Asia/Chongqing': 'China',
  'Asia/Urumqi': 'China',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Macau': 'Macau',
  'Asia/Taipei': 'Taiwan',
  'Asia/Singapore': 'Singapore',
  'Asia/Bangkok': 'Thailand',
  'Asia/Ho_Chi_Minh': 'Vietnam',
  'Asia/Hanoi': 'Vietnam',
  'Asia/Jakarta': 'Indonesia',
  'Asia/Manila': 'Philippines',
  'Asia/Kuala_Lumpur': 'Malaysia',
  'Asia/Kolkata': 'India',
  'Asia/Mumbai': 'India',
  'Asia/Delhi': 'India',
  'Asia/Karachi': 'Pakistan',
  'Asia/Dhaka': 'Bangladesh',
  'Asia/Kathmandu': 'Nepal',
  'Asia/Dubai': 'United Arab Emirates',
  'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Kuwait': 'Kuwait',
  'Asia/Qatar': 'Qatar',
  'Asia/Bahrain': 'Bahrain',
  'Asia/Muscat': 'Oman',
  'Asia/Tehran': 'Iran',
  'Asia/Baghdad': 'Iraq',
  'Asia/Jerusalem': 'Israel',
  'Asia/Beirut': 'Lebanon',
  'Asia/Damascus': 'Syria',
  'Asia/Amman': 'Jordan',
  'Asia/Istanbul': 'Turkey',
  'Asia/Yerevan': 'Armenia',
  'Asia/Tbilisi': 'Georgia',
  'Asia/Baku': 'Azerbaijan',
  'Asia/Tashkent': 'Uzbekistan',
  'Asia/Almaty': 'Kazakhstan',

  // Europe
  'Europe/London': 'United Kingdom',
  'Europe/Dublin': 'Ireland',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Rome': 'Italy',
  'Europe/Madrid': 'Spain',
  'Europe/Barcelona': 'Spain',
  'Europe/Lisbon': 'Portugal',
  'Europe/Amsterdam': 'Netherlands',
  'Europe/Brussels': 'Belgium',
  'Europe/Vienna': 'Austria',
  'Europe/Zurich': 'Switzerland',
  'Europe/Prague': 'Czech Republic',
  'Europe/Warsaw': 'Poland',
  'Europe/Budapest': 'Hungary',
  'Europe/Athens': 'Greece',
  'Europe/Stockholm': 'Sweden',
  'Europe/Oslo': 'Norway',
  'Europe/Copenhagen': 'Denmark',
  'Europe/Helsinki': 'Finland',
  'Europe/Moscow': 'Russia',
  'Europe/Istanbul': 'Turkey',
  'Europe/Kiev': 'Ukraine',
  'Europe/Bucharest': 'Romania',
  'Europe/Sofia': 'Bulgaria',
  'Europe/Belgrade': 'Serbia',
  'Europe/Zagreb': 'Croatia',

  // America
  'America/New_York': 'United States',
  'America/Chicago': 'United States',
  'America/Denver': 'United States',
  'America/Los_Angeles': 'United States',
  'America/Phoenix': 'United States',
  'America/Anchorage': 'United States',
  'America/Toronto': 'Canada',
  'America/Vancouver': 'Canada',
  'America/Montreal': 'Canada',
  'America/Mexico_City': 'Mexico',
  'America/Sao_Paulo': 'Brazil',
  'America/Rio_de_Janeiro': 'Brazil',
  'America/Buenos_Aires': 'Argentina',
  'America/Santiago': 'Chile',
  'America/Lima': 'Peru',
  'America/Bogota': 'Colombia',
  'America/Caracas': 'Venezuela',
  'America/Havana': 'Cuba',
  'America/Panama': 'Panama',
  'America/Costa_Rica': 'Costa Rica',

  // Pacific
  'Pacific/Honolulu': 'United States',
  'Pacific/Auckland': 'New Zealand',
  'Pacific/Fiji': 'Fiji',
  'Pacific/Guam': 'Guam',

  // Australia
  'Australia/Sydney': 'Australia',
  'Australia/Melbourne': 'Australia',
  'Australia/Brisbane': 'Australia',
  'Australia/Perth': 'Australia',
  'Australia/Adelaide': 'Australia',

  // Africa
  'Africa/Cairo': 'Egypt',
  'Africa/Johannesburg': 'South Africa',
  'Africa/Lagos': 'Nigeria',
  'Africa/Nairobi': 'Kenya',
  'Africa/Casablanca': 'Morocco',
  'Africa/Algiers': 'Algeria',

  // Special
  'UTC': 'UTC',
};

// Get all IANA timezones from browser (CLDR data)
const getAllTimezones = () => {
  try {
    // Get all supported timezones from Intl API (IANA/CLDR database)
    const timezones = Intl.supportedValuesOf('timeZone');

    return timezones.map(tz => {
      // Parse timezone identifier: "America/New_York" -> region: "America", city: "New York"
      const parts = tz.split('/');
      const region = parts[0];
      const city = parts.slice(1).join('/').replace(/_/g, ' ');
      const country = TIMEZONE_COUNTRIES[tz] || region;

      return {
        value: tz,
        label: city || tz,
        city: city || tz,
        region: region,
        country: country
      };
    }).sort((a, b) => a.city.localeCompare(b.city));
  } catch {
    // Fallback to basic list if browser doesn't support Intl.supportedValuesOf
    console.warn('Intl.supportedValuesOf not supported, using fallback list');
    return [
      { value: 'UTC', label: 'UTC', city: 'UTC', region: 'UTC', country: 'UTC' },
      { value: 'America/New_York', label: 'New York', city: 'New York', region: 'America', country: 'United States' },
      { value: 'America/Chicago', label: 'Chicago', city: 'Chicago', region: 'America', country: 'United States' },
      { value: 'America/Los_Angeles', label: 'Los Angeles', city: 'Los Angeles', region: 'America', country: 'United States' },
      { value: 'Europe/London', label: 'London', city: 'London', region: 'Europe', country: 'United Kingdom' },
      { value: 'Europe/Paris', label: 'Paris', city: 'Paris', region: 'Europe', country: 'France' },
      { value: 'Asia/Tokyo', label: 'Tokyo', city: 'Tokyo', region: 'Asia', country: 'Japan' },
      { value: 'Australia/Sydney', label: 'Sydney', city: 'Sydney', region: 'Australia', country: 'Australia' },
    ];
  }
};

const ALL_TIMEZONES = getAllTimezones();

export default function TimeZoneConverterTool() {
  const [selectedDateTime, setSelectedDateTime] = useState(null);
  const [useCurrentTime, setUseCurrentTime] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [pinnedTimezones, setPinnedTimezones] = useState(() => {
    const saved = localStorage.getItem('pinnedTimezones');
    return saved ? JSON.parse(saved) : ['America/New_York', 'Europe/London', 'Asia/Tokyo'];
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [timeOffset, setTimeOffset] = useState(0); // Hours offset from current/selected time
  const [hoveredTimezone, setHoveredTimezone] = useState(null);

  // Update current time every second when using current time
  useEffect(() => {
    if (!useCurrentTime) return;

    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, [useCurrentTime]);

  // Save pinned timezones to localStorage
  useEffect(() => {
    localStorage.setItem('pinnedTimezones', JSON.stringify(pinnedTimezones));
  }, [pinnedTimezones]);

  // Apply time offset to display time
  const baseTime = useCurrentTime ? currentTime : (selectedDateTime ? new Date(selectedDateTime) : new Date());
  const displayTime = new Date(baseTime.getTime() + timeOffset * 60 * 60 * 1000);

  const handleAddTimezone = (timezone) => {
    if (!pinnedTimezones.includes(timezone)) {
      setPinnedTimezones([...pinnedTimezones, timezone]);
      setSearchQuery('');
    }
  };

  const handleRemoveTimezone = (timezone) => {
    setPinnedTimezones(pinnedTimezones.filter(tz => tz !== timezone));
  };

  const formatTimeInTimezone = (date, timezone) => {
    try {
      const timeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      return timeFormatter.format(date);
    } catch {
      return 'Invalid';
    }
  };

  const formatDateInTimezone = (date, timezone) => {
    try {
      const dateFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return dateFormatter.format(date);
    } catch {
      return 'Invalid';
    }
  };

  const getTimezoneOffset = (date, timezone) => {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      });
      const parts = formatter.formatToParts(date);
      const timeZoneName = parts.find(part => part.type === 'timeZoneName')?.value || '';
      return timeZoneName;
    } catch {
      return '';
    }
  };

  const getTimezoneAbbreviation = (timezone) => {
    try {
      const date = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      });
      const parts = formatter.formatToParts(date);
      const abbr = parts.find(part => part.type === 'timeZoneName')?.value || '';
      return abbr;
    } catch {
      return '';
    }
  };

  const getTimezoneLabel = (timezone) => {
    const found = ALL_TIMEZONES.find(tz => tz.value === timezone);
    return found ? found.label : timezone;
  };

  const getTimezoneOffsetHours = (timezone) => {
    try {
      const date = new Date();
      const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      const offset = (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
      return offset;
    } catch {
      return 0;
    }
  };

  const formatOffsetString = (offset) => {
    const sign = offset >= 0 ? '+' : '';
    const hours = Math.floor(Math.abs(offset));
    const minutes = Math.round((Math.abs(offset) - hours) * 60);
    if (minutes === 0) {
      return `UTC${sign}${offset}`;
    }
    return `UTC${sign}${offset.toFixed(1).replace('.5', ':30')}`;
  };

  const filteredTimezones = ALL_TIMEZONES.filter(tz => {
    if (pinnedTimezones.includes(tz.value)) return false;

    const query = searchQuery.toLowerCase();

    // Check if searching by offset (GMT+9, UTC+9, +9, etc.)
    const offsetMatch = query.match(/(?:gmt|utc)?([+-]?\d+(?:\.\d+)?)/);
    if (offsetMatch) {
      const searchOffset = parseFloat(offsetMatch[1]);
      const tzOffset = getTimezoneOffsetHours(tz.value);
      if (Math.abs(tzOffset - searchOffset) < 0.1) return true;
    }

    // Check if searching by timezone abbreviation (EST, PST, CEST, JST, etc.)
    const abbreviation = getTimezoneAbbreviation(tz.value).toLowerCase();
    if (abbreviation && abbreviation === query) {
      return true;
    }

    // Regular text search
    return (
      tz.city.toLowerCase().includes(query) ||
      tz.region.toLowerCase().includes(query) ||
      tz.country.toLowerCase().includes(query) ||
      tz.value.toLowerCase().includes(query) ||
      tz.label.toLowerCase().includes(query)
    );
  });

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Globe size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">Time Zone Converter</h3>
        </div>

        {/* Add Timezone Section */}
        <div className="relative">
          <label className="block text-sm text-os-text-primary mb-2">Add Time Zone</label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by city, country, offset, or abbreviation..."
                className="w-full pl-9 pr-3 py-2 border border-os-border rounded-sm bg-os-card text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              />
            </div>
          </div>

          {/* Search Results */}
          {searchQuery && (
            <div className="absolute z-50 mt-2 w-full max-h-48 overflow-y-auto border border-os-border rounded-sm bg-os-card shadow-lg">
              {filteredTimezones.length > 0 ? (
                filteredTimezones.slice(0, 10).map((tz) => (
                  <button
                    key={tz.value}
                    onClick={() => handleAddTimezone(tz.value)}
                    className="w-full px-3 py-2 text-left hover:bg-os-card-secondary transition-colors flex items-center justify-between group"
                  >
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-os-text-primary">{tz.city}</div>
                        <div className="text-xs text-os-text-muted font-mono ml-2">
                          {formatOffsetString(getTimezoneOffsetHours(tz.value))}
                        </div>
                      </div>
                      <div className="text-xs text-os-text-muted">{tz.country}</div>
                    </div>
                    <Plus size={14} className="text-os-text-muted group-hover:text-os-blue ml-2" />
                  </button>
                ))
              ) : (
                <div className="px-3 py-4 text-center text-sm text-os-text-muted">
                  No timezones found
                </div>
              )}
            </div>
          )}
        </div>

        {/* Time Offset Slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-os-text-primary">Time Offset</label>
            <span className="text-xs text-os-text-muted">
              {timeOffset === 0 ? 'Live' : `${timeOffset > 0 ? '+' : ''}${timeOffset}h`}
            </span>
          </div>
          <div className="relative">
            <input
              type="range"
              min="-24"
              max="24"
              step="1"
              value={timeOffset}
              onChange={(e) => {
                const offset = parseInt(e.target.value);
                setTimeOffset(offset);
                if (offset === 0) {
                  setUseCurrentTime(true);
                } else {
                  if (useCurrentTime) {
                    setSelectedDateTime(currentTime.toISOString());
                  }
                  setUseCurrentTime(false);
                }
              }}
              className="w-full h-2 bg-os-card-secondary appearance-none cursor-pointer accent-os-blue"
              style={{
                background: `linear-gradient(to right,
                  var(--os-card-secondary) 0%,
                  var(--os-card-secondary) ${((timeOffset + 24) / 48) * 100}%,
                  var(--os-card-secondary) ${((timeOffset + 24) / 48) * 100}%,
                  var(--os-card-secondary) 100%)`
              }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-0.5 h-4 bg-os-blue pointer-events-none"
              style={{ left: '50%' }}
            />
          </div>
          <div className="flex justify-between text-xs text-os-text-muted">
            <span>-24h</span>
            <span>Live</span>
            <span>+24h</span>
          </div>
        </div>

        {/* Pinned Timezones Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...pinnedTimezones]
            .sort((a, b) => {
              // Sort by actual time in each timezone
              const timeA = new Date(displayTime).toLocaleString('en-US', { timeZone: a, hour12: false });
              const timeB = new Date(displayTime).toLocaleString('en-US', { timeZone: b, hour12: false });
              return timeA.localeCompare(timeB);
            })
            .map((timezone) => (
            <div
              key={timezone}
              onMouseEnter={() => setHoveredTimezone(timezone)}
              onMouseLeave={() => setHoveredTimezone(null)}
              className={`p-3 border rounded transition-colors ${
 hoveredTimezone === timezone
 ?'bg-os-card-secondary border-os-border'
 :'bg-os-card border-os-border hover:bg-os-card-secondary'
 }`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-os-text-primary truncate">
                      {getTimezoneLabel(timezone)}
                    </span>
                    <span className="text-xs text-os-text-muted font-mono shrink-0">
                      {getTimezoneOffset(displayTime, timezone)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveTimezone(timezone)}
                  className="p-1 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm transition-colors shrink-0"
                  title="Remove timezone"
                >
                  <Trash2 size={12} className="text-red-600 dark:text-red-400" />
                </button>
              </div>
              <div className="text-2xl font-mono font-semibold text-os-text-primary">
                {formatTimeInTimezone(displayTime, timezone)}
              </div>
              <div className="text-xs text-os-text-muted mt-1">
                {formatDateInTimezone(displayTime, timezone)}
              </div>
            </div>
          ))}

          {pinnedTimezones.length === 0 && (
            <div className="col-span-full text-center py-8 bg-os-card border border-os-border rounded-sm">
              <Globe size={32} className="text-os-text-muted mx-auto mb-2 opacity-50" />
              <p className="text-sm text-os-text-secondary">No timezones added</p>
              <p className="text-xs text-os-text-muted mt-1">Search and add timezones above</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
