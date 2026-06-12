'use strict';
const SOURCES = {
  // ─── Domestic Finance ───
  Caixin:{color:'#d4251a',label:'财新',full:'财新网',lang:'zh'},
  STCN:{color:'#e74c3c',label:'证券时报',full:'证券时报',lang:'zh'},
  NBD:{color:'#e67e22',label:'每经',full:'每日经济新闻',lang:'zh'},
  '21Jingji':{color:'#c0392b',label:'21经济',full:'21世纪经济报道',lang:'zh'},
  Yicai:{color:'#3498db',label:'第一财经',full:'第一财经',lang:'zh'},
  XinhuaFin:{color:'#e74c3c',label:'新华财经',full:'新华财经',lang:'zh'},
  CEWeekly:{color:'#2c3e50',label:'经济周刊',full:'中国经济周刊',lang:'zh'},

  // ─── Domestic Politics ───
  CCTV:{color:'#e8362a',label:'央视',full:'央视新闻',lang:'zh'},
  Xinhua:{color:'#c0392b',label:'新华',full:'新华社',lang:'zh'},
  PeopleDaily:{color:'#c62828',label:'人民',full:'人民日报',lang:'zh'},
  GTimes:{color:'#1565c0',label:'环球',full:'环球时报',lang:'zh'},
  ChinaDaily:{color:'#0d47a1',label:'CD',full:'中国日报',lang:'zh'},
  ChinaNews:{color:'#c62828',label:'中新',full:'中国新闻网',lang:'zh'},
  FMPRC:{color:'#b71c1c',label:'外交部',full:'外交部发言人',lang:'zh'},
  MOFCOM:{color:'#b71c1c',label:'商务',full:'商务部',lang:'zh'},

  // ─── Domestic Military ───
  MOD:{color:'#3e2723',label:'国防部',full:'国防部发布',lang:'zh'},
  PLADaily:{color:'#4a148c',label:'军报',full:'解放军报',lang:'zh'},
  PLAOnline:{color:'#4a148c',label:'军网',full:'中国军网',lang:'zh'},
  XinhuaMil:{color:'#c0392b',label:'新华军事',full:'新华网军事',lang:'zh'},
  GTimesMil:{color:'#1565c0',label:'环球军事',full:'环球时报军事',lang:'zh'},
  Cankaoxiaoxi:{color:'#1b5e20',label:'参考消息',full:'参考消息',lang:'zh'},
  ThePaper:{color:'#d84315',label:'澎湃',full:'澎湃新闻',lang:'zh'},
  GuanchaMil:{color:'#d32f2f',label:'观察者网',full:'观察者网军事',lang:'zh'},
  CNRMil:{color:'#b71c1c',label:'央广军',full:'央广军事',lang:'zh'},
  IfengMil:{color:'#d84315',label:'凤凰军',full:'凤凰网军事',lang:'zh'},
  QQMIL:{color:'#2196f3',label:'腾讯军',full:'腾讯新闻军事',lang:'zh'},
  DSTI:{color:'#00695c',label:'国防科技',full:'国防科技信息网',lang:'zh'},
  CNSA:{color:'#004d40',label:'航天',full:'中国航天',lang:'zh'},
  PBOC:{color:'#1a237e',label:'央行',full:'中国人民银行',lang:'zh'},
  CNStock:{color:'#1b5e20',label:'证券',full:'证券时报',lang:'zh'},

  // ─── International Finance ───
  Bloomberg:{color:'#1a56db',label:'BB',full:'彭博社',lang:'en'},
  Reuters:{color:'#e05252',label:'RT',full:'路透社',lang:'en'},
  FT:{color:'#f05e2a',label:'FT',full:'金融时报',lang:'en'},
  WSJ:{color:'#1a1a1a',label:'WJ',full:'华尔街日报',lang:'en'},
  Economist:{color:'#e03030',label:'EC',full:'经济学人',lang:'en'},
  CNBC:{color:'#0066cc',label:'CN',full:'CNBC',lang:'en'},
  Fortune:{color:'#0d7a3a',label:'FN',full:'财富杂志',lang:'en'},
  MarketWatch:{color:'#1d8c4a',label:'MW',full:'MarketWatch',lang:'en'},
  NikkeiAsia:{color:'#1a237e',label:'NK',full:'日本经济新闻',lang:'en'},
  EconTimes:{color:'#e65100',label:'ET',full:'印度经济时报',lang:'en'},

  // ─── International Politics ───
  BBC:{color:'#BB1919',label:'BC',full:'BBC新闻',lang:'en'},
  CNN:{color:'#cc0000',label:'CN',full:'CNN',lang:'en'},
  Guardian:{color:'#003f5c',label:'GD',full:'卫报',lang:'en'},
  AP:{color:'#333333',label:'AP',full:'AP通讯社',lang:'en'},
  AlJazeera:{color:'#007a3d',label:'AJ',full:'半岛电视台',lang:'en'},
  Politico:{color:'#d4251a',label:'PO',full:'Politico',lang:'en'},
  ABCNews:{color:'#1a1a1a',label:'AB',full:'ABC新闻',lang:'en'},
  WashingtonPost:{color:'#1e1e1e',label:'WP',full:'华盛顿邮报',lang:'en'},
  TheHindu:{color:'#d32f2f',label:'TH',full:'印度教徒报',lang:'en'},
  Time:{color:'#cc0000',label:'TM',full:'时代周刊',lang:'en'},
  Newsweek:{color:'#c62828',label:'NW',full:'新闻周刊',lang:'en'},
  Independent:{color:'#cc0000',label:'IN',full:'独立报',lang:'en'},
  France24:{color:'#0099cc',label:'F24',full:'France24',lang:'en'},
  DW:{color:'#0066b3',label:'DW',full:'德国之声',lang:'en'},
  NYT:{color:'#333333',label:'NY',full:'纽约时报',lang:'en'},
  AsahiShimbun:{color:'#1565c0',label:'朝日',full:'朝日新闻',lang:'ja'},
  Yonhap:{color:'#0066b3',label:'YN',full:'韩联社',lang:'en'},
  StraitsTimes:{color:'#003d7a',label:'ST',full:'联合早报',lang:'en'},
  TimesOfIndia:{color:'#e65100',label:'TI',full:'印度时报',lang:'en'},
  NHK:{color:'#0a7abf',label:'NK',full:'NHK世界',lang:'en'},
  SCMP:{color:'#7b1fa2',label:'SC',full:'南华早报',lang:'en'},

  // ─── International Military ───
  DefenseNews:{color:'#5a6a80',label:'DN',full:'防务新闻',lang:'en'},
  USNI:{color:'#1d3a6e',label:'UN',full:'USNI新闻',lang:'en'},
  JaneDef:{color:'#2d4a7a',label:'JD',full:'简氏防务',lang:'en'},
  MilitaryTimes:{color:'#3a4a5a',label:'MT',full:'军事时报',lang:'en'},
  AlMonitor:{color:'#004d40',label:'AM',full:'Al-Monitor',lang:'en'},
  WarZone:{color:'#b71c1c',label:'WZ',full:'The War Zone',lang:'en'},
  NavalNews:{color:'#1a5276',label:'NN',full:'海军新闻',lang:'en'}
};

function isChinese(src){return SOURCES[src]&&SOURCES[src].lang==='zh';}
function getSrc(key){return SOURCES[key]||{color:'#888',label:key?key.slice(0,4):'??',full:key||'Unknown',lang:'en'};}
module.exports={SOURCES,isChinese,getSrc};