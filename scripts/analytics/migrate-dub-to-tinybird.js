// ESM module (root package.json has "type":"module")
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DUB_API_URL = "https://api.dub.co";
const DEFAULT_DOMAIN = "cap.link";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_INTERVAL = "30d";
const DEFAULT_HOST =
	process.env.TINYBIRD_HOST?.trim() || "https://api.tinybird.co";
const TB_DATASOURCE = "analytics_events";
const MAX_CITY_COUNT = 25;
const INGEST_CHUNK_SIZE = 5000;
const DEFAULT_VIDEO_CONCURRENCY = Number(process.env.VIDEO_CONCURRENCY || 4);
const DEFAULT_API_CONCURRENCY = Number(process.env.DUB_CONCURRENCY || 8);
const DEFAULT_INGEST_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || 4);
const DEFAULT_INGEST_RATE_LIMIT = Number(process.env.INGEST_RATE_LIMIT || 10);

export const REGIONS = {
	"AF-BDS": "Badakhshān",
	"AF-BDG": "Bādghīs",
	"AF-BGL": "Baghlān",
	"AF-BAL": "Balkh",
	"AF-BAM": "Bāmyān",
	"AF-DAY": "Dāykundī",
	"AF-FRA": "Farāh",
	"AF-FYB": "Fāryāb",
	"AF-GHA": "Ghaznī",
	"AF-GHO": "Ghōr",
	"AF-HEL": "Helmand",
	"AF-HER": "Herāt",
	"AF-JOW": "Jowzjān",
	"AF-KAB": "Kābul",
	"AF-KAN": "Kandahār",
	"AF-KAP": "Kāpīsā",
	"AF-KHO": "Khōst",
	"AF-KNR": "Kunaṟ",
	"AF-KDZ": "Kunduz",
	"AF-LAG": "Laghmān",
	"AF-LOG": "Lōgar",
	"AF-NAN": "Nangarhār",
	"AF-NIM": "Nīmrōz",
	"AF-NUR": "Nūristān",
	"AF-PKA": "Paktīkā",
	"AF-PIA": "Paktiyā",
	"AF-PAN": "Panjshayr",
	"AF-PAR": "Parwān",
	"AF-SAM": "Samangān",
	"AF-SAR": "Sar-e Pul",
	"AF-TAK": "Takhār",
	"AF-URU": "Uruzgān",
	"AF-WAR": "Wardak",
	"AF-ZAB": "Zābul",
	"AL-01": "Berat",
	"AL-09": "Dibër",
	"AL-02": "Durrës",
	"AL-03": "Elbasan",
	"AL-04": "Fier",
	"AL-05": "Gjirokastër",
	"AL-06": "Korçë",
	"AL-07": "Kukës",
	"AL-08": "Lezhë",
	"AL-10": "Shkodër",
	"AL-11": "Tiranë",
	"AL-12": "Vlorë",
	"DZ-01": "Adrar",
	"DZ-44": "Aïn Defla",
	"DZ-46": "Aïn Témouchent",
	"DZ-16": "Alger",
	"DZ-23": "Annaba",
	"DZ-05": "Batna",
	"DZ-08": "Béchar",
	"DZ-06": "Béjaïa",
	"DZ-52": "Béni Abbès",
	"DZ-07": "Biskra",
	"DZ-09": "Blida",
	"DZ-50": "Bordj Badji Mokhtar",
	"DZ-34": "Bordj Bou Arréridj",
	"DZ-10": "Bouira",
	"DZ-35": "Boumerdès",
	"DZ-02": "Chlef",
	"DZ-25": "Constantine",
	"DZ-56": "Djanet",
	"DZ-17": "Djelfa",
	"DZ-32": "El Bayadh",
	"DZ-57": "El Meghaier",
	"DZ-58": "El Meniaa",
	"DZ-39": "El Oued",
	"DZ-36": "El Tarf",
	"DZ-47": "Ghardaïa",
	"DZ-24": "Guelma",
	"DZ-33": "Illizi",
	"DZ-54": "In Guezzam",
	"DZ-53": "In Salah",
	"DZ-18": "Jijel",
	"DZ-40": "Khenchela",
	"DZ-03": "Laghouat",
	"DZ-28": "M'sila",
	"DZ-29": "Mascara",
	"DZ-26": "Médéa",
	"DZ-43": "Mila",
	"DZ-27": "Mostaganem",
	"DZ-45": "Naama",
	"DZ-31": "Oran",
	"DZ-30": "Ouargla",
	"DZ-51": "Ouled Djellal",
	"DZ-04": "Oum el Bouaghi",
	"DZ-48": "Relizane",
	"DZ-20": "Saïda",
	"DZ-19": "Sétif",
	"DZ-22": "Sidi Bel Abbès",
	"DZ-21": "Skikda",
	"DZ-41": "Souk Ahras",
	"DZ-11": "Tamanrasset",
	"DZ-12": "Tébessa",
	"DZ-14": "Tiaret",
	"DZ-49": "Timimoun",
	"DZ-37": "Tindouf",
	"DZ-42": "Tipaza",
	"DZ-38": "Tissemsilt",
	"DZ-15": "Tizi Ouzou",
	"DZ-13": "Tlemcen",
	"DZ-55": "Touggourt",
	"AD-07": "Andorra la Vella",
	"AD-02": "Canillo",
	"AD-03": "Encamp",
	"AD-08": "Escaldes-Engordany",
	"AD-04": "La Massana",
	"AD-05": "Ordino",
	"AD-06": "Sant Julià de Lòria",
	"AO-BGO": "Bengo",
	"AO-BGU": "Benguela",
	"AO-BIE": "Bié",
	"AO-CAB": "Cabinda",
	"AO-CCU": "Cuando Cubango",
	"AO-CNO": "Cuanza-Norte",
	"AO-CUS": "Cuanza-Sul",
	"AO-CNN": "Cunene",
	"AO-HUA": "Huambo",
	"AO-HUI": "Huíla",
	"AO-LUA": "Luanda",
	"AO-LNO": "Lunda-Norte",
	"AO-LSU": "Lunda-Sul",
	"AO-MAL": "Malange",
	"AO-MOX": "Moxico",
	"AO-NAM": "Namibe",
	"AO-UIG": "Uíge",
	"AO-ZAI": "Zaire",
	"AG-03": "Saint George",
	"AG-04": "Saint John",
	"AG-05": "Saint Mary",
	"AG-06": "Saint Paul",
	"AG-07": "Saint Peter",
	"AG-08": "Saint Philip",
	"AG-10": "Barbuda",
	"AG-11": "Redonda",
	"AR-B": "Buenos Aires",
	"AR-K": "Catamarca",
	"AR-H": "Chaco",
	"AR-U": "Chubut",
	"AR-C": "Ciudad Autónoma de Buenos Aires",
	"AR-X": "Córdoba",
	"AR-W": "Corrientes",
	"AR-E": "Entre Ríos",
	"AR-P": "Formosa",
	"AR-Y": "Jujuy",
	"AR-L": "La Pampa",
	"AR-F": "La Rioja",
	"AR-M": "Mendoza",
	"AR-N": "Misiones",
	"AR-Q": "Neuquén",
	"AR-R": "Río Negro",
	"AR-A": "Salta",
	"AR-J": "San Juan",
	"AR-D": "San Luis",
	"AR-Z": "Santa Cruz",
	"AR-S": "Santa Fe",
	"AR-G": "Santiago del Estero",
	"AR-V": "Tierra del Fuego",
	"AR-T": "Tucumán",
	"AM-AG": "Aragac̣otn",
	"AM-AR": "Ararat",
	"AM-AV": "Armavir",
	"AM-ER": "Erevan",
	"AM-GR": "Geġark'unik'",
	"AM-KT": "Kotayk'",
	"AM-LO": "Loṙi",
	"AM-SH": "Širak",
	"AM-SU": "Syunik'",
	"AM-TV": "Tavuš",
	"AM-VD": "Vayoć Jor",
	"AU-NSW": "New South Wales",
	"AU-QLD": "Queensland",
	"AU-SA": "South Australia",
	"AU-TAS": "Tasmania",
	"AU-VIC": "Victoria",
	"AU-WA": "Western Australia",
	"AU-ACT": "Australian Capital Territory",
	"AU-NT": "Northern Territory",
	"AT-1": "Burgenland",
	"AT-2": "Kärnten",
	"AT-3": "Niederösterreich",
	"AT-4": "Oberösterreich",
	"AT-5": "Salzburg",
	"AT-6": "Steiermark",
	"AT-7": "Tirol",
	"AT-8": "Vorarlberg",
	"AT-9": "Wien",
	"AZ-NX": "Naxçıvan",
	"BS-AK": "Acklins",
	"BS-BY": "Berry Islands",
	"BS-BI": "Bimini",
	"BS-BP": "Black Point",
	"BS-CI": "Cat Island",
	"BS-CO": "Central Abaco",
	"BS-CS": "Central Andros",
	"BS-CE": "Central Eleuthera",
	"BS-FP": "City of Freeport",
	"BS-CK": "Crooked Island and Long Cay",
	"BS-EG": "East Grand Bahama",
	"BS-EX": "Exuma",
	"BS-GC": "Grand Cay",
	"BS-HI": "Harbour Island",
	"BS-HT": "Hope Town",
	"BS-IN": "Inagua",
	"BS-LI": "Long Island",
	"BS-MC": "Mangrove Cay",
	"BS-MG": "Mayaguana",
	"BS-MI": "Moore's Island",
	"BS-NP": "New Providence",
	"BS-NO": "North Abaco",
	"BS-NS": "North Andros",
	"BS-NE": "North Eleuthera",
	"BS-RI": "Ragged Island",
	"BS-RC": "Rum Cay",
	"BS-SS": "San Salvador",
	"BS-SO": "South Abaco",
	"BS-SA": "South Andros",
	"BS-SE": "South Eleuthera",
	"BS-SW": "Spanish Wells",
	"BS-WG": "West Grand Bahama",
	"BH-13": "Al ‘Āşimah",
	"BH-14": "Al Janūbīyah",
	"BH-15": "Al Muḩarraq",
	"BH-17": "Ash Shamālīyah",
	"BD-A": "Barishal",
	"BD-B": "Chattogram",
	"BD-C": "Dhaka",
	"BD-D": "Khulna",
	"BD-H": "Mymensingh",
	"BD-E": "Rajshahi",
	"BD-F": "Rangpur",
	"BD-G": "Sylhet",
	"BB-01": "Christ Church",
	"BB-02": "Saint Andrew",
	"BB-03": "Saint George",
	"BB-04": "Saint James",
	"BB-05": "Saint John",
	"BB-06": "Saint Joseph",
	"BB-07": "Saint Lucy",
	"BB-08": "Saint Michael",
	"BB-09": "Saint Peter",
	"BB-10": "Saint Philip",
	"BB-11": "Saint Thomas",
	"BY-BR": "Brestskaya voblasts'",
	"BY-HO": "Homyel'skaya voblasts'",
	"BY-HM": "Horad Minsk",
	"BY-HR": "Hrodzyenskaya voblasts'",
	"BY-MA": "Mahilyowskaya voblasts'",
	"BY-MI": "Minskaya voblasts'",
	"BY-VI": "Vitsyebskaya voblasts'",
	"BE-BRU": "Brussels Hoofdstedelijk Gewest",
	"BE-VLG": "Vlaams Gewest",
	"BE-WAL": "Waals Gewest[note 2]",
	"BZ-BZ": "Belize",
	"BZ-CY": "Cayo",
	"BZ-CZL": "Corozal",
	"BZ-OW": "Orange Walk",
	"BZ-SC": "Stann Creek",
	"BZ-TOL": "Toledo",
	"BJ-AL": "Alibori",
	"BJ-AK": "Atacora",
	"BJ-AQ": "Atlantique",
	"BJ-BO": "Borgou",
	"BJ-CO": "Collines",
	"BJ-KO": "Couffo",
	"BJ-DO": "Donga",
	"BJ-LI": "Littoral",
	"BJ-MO": "Mono",
	"BJ-OU": "Ouémé",
	"BJ-PL": "Plateau",
	"BJ-ZO": "Zou",
	"BT-33": "Bumthang",
	"BT-12": "Chhukha",
	"BT-22": "Dagana",
	"BT-GA": "Gasa",
	"BT-13": "Haa",
	"BT-44": "Lhuentse",
	"BT-42": "Monggar",
	"BT-11": "Paro",
	"BT-43": "Pema Gatshel",
	"BT-23": "Punakha",
	"BT-45": "Samdrup Jongkhar",
	"BT-14": "Samtse",
	"BT-31": "Sarpang",
	"BT-15": "Thimphu",
	"BT-41": "Trashigang",
	"BT-TY": "Trashi Yangtse",
	"BT-32": "Trongsa",
	"BT-21": "Tsirang",
	"BT-24": "Wangdue Phodrang",
	"BT-34": "Zhemgang",
	"BO-C": "Cochabamba",
	"BO-H": "Chuquisaca",
	"BO-B": "El Beni",
	"BO-L": "La Paz",
	"BO-O": "Oruro",
	"BO-N": "Pando",
	"BO-P": "Potosí",
	"BO-S": "Santa Cruz",
	"BO-T": "Tarija",
	"BA-BIH": "Federacija Bosne i Hercegovine",
	"BA-SRP": "Republika Srpska",
	"BA-BRC": "Brčko distrikt",
	"BW-CE": "Central",
	"BW-CH": "Chobe",
	"BW-FR": "Francistown",
	"BW-GA": "Gaborone",
	"BW-GH": "Ghanzi",
	"BW-JW": "Jwaneng",
	"BW-KG": "Kgalagadi",
	"BW-KL": "Kgatleng",
	"BW-KW": "Kweneng",
	"BW-LO": "Lobatse",
	"BW-NE": "North East",
	"BW-NW": "North West",
	"BW-SP": "Selibe Phikwe",
	"BW-SE": "South East",
	"BW-SO": "Southern",
	"BW-ST": "Sowa Town",
	"BR-AC": "Acre",
	"BR-AL": "Alagoas",
	"BR-AP": "Amapá",
	"BR-AM": "Amazonas",
	"BR-BA": "Bahia",
	"BR-CE": "Ceará",
	"BR-DF": "Distrito Federal",
	"BR-ES": "Espírito Santo",
	"BR-GO": "Goiás",
	"BR-MA": "Maranhão",
	"BR-MT": "Mato Grosso",
	"BR-MS": "Mato Grosso do Sul",
	"BR-MG": "Minas Gerais",
	"BR-PA": "Pará",
	"BR-PB": "Paraíba",
	"BR-PR": "Paraná",
	"BR-PE": "Pernambuco",
	"BR-PI": "Piauí",
	"BR-RJ": "Rio de Janeiro",
	"BR-RN": "Rio Grande do Norte",
	"BR-RS": "Rio Grande do Sul",
	"BR-RO": "Rondônia",
	"BR-RR": "Roraima",
	"BR-SC": "Santa Catarina",
	"BR-SP": "São Paulo",
	"BR-SE": "Sergipe",
	"BR-TO": "Tocantins",
	"BN-BE": "Belait",
	"BN-BM": "Brunei-Muara",
	"BN-TE": "Temburong",
	"BN-TU": "Tutong",
	"BG-01": "Blagoevgrad",
	"BG-02": "Burgas",
	"BG-08": "Dobrich",
	"BG-07": "Gabrovo",
	"BG-26": "Haskovo",
	"BG-09": "Kardzhali",
	"BG-10": "Kyustendil",
	"BG-11": "Lovech",
	"BG-12": "Montana",
	"BG-13": "Pazardzhik",
	"BG-14": "Pernik",
	"BG-15": "Pleven",
	"BG-16": "Plovdiv",
	"BG-17": "Razgrad",
	"BG-18": "Ruse",
	"BG-27": "Shumen",
	"BG-19": "Silistra",
	"BG-20": "Sliven",
	"BG-21": "Smolyan",
	"BG-23": "Sofia",
	"BG-22": "Sofia (stolitsa)",
	"BG-24": "Stara Zagora",
	"BG-25": "Targovishte",
	"BG-03": "Varna",
	"BG-04": "Veliko Tarnovo",
	"BG-05": "Vidin",
	"BG-06": "Vratsa",
	"BG-28": "Yambol",
	"BF-01": "Boucle du Mouhoun",
	"BF-02": "Cascades",
	"BF-03": "Centre",
	"BF-04": "Centre-Est",
	"BF-05": "Centre-Nord",
	"BF-06": "Centre-Ouest",
	"BF-07": "Centre-Sud",
	"BF-08": "Est",
	"BF-09": "Hauts-Bassins",
	"BF-10": "Nord",
	"BF-11": "Plateau-Central",
	"BF-12": "Sahel",
	"BF-13": "Sud-Ouest",
	"BI-BB": "Bubanza",
	"BI-BM": "Bujumbura Mairie",
	"BI-BL": "Bujumbura Rural",
	"BI-BR": "Bururi",
	"BI-CA": "Cankuzo",
	"BI-CI": "Cibitoke",
	"BI-GI": "Gitega",
	"BI-KR": "Karuzi",
	"BI-KY": "Kayanza",
	"BI-KI": "Kirundo",
	"BI-MA": "Makamba",
	"BI-MU": "Muramvya",
	"BI-MY": "Muyinga",
	"BI-MW": "Mwaro",
	"BI-NG": "Ngozi",
	"BI-RM": "Rumonge",
	"BI-RT": "Rutana",
	"BI-RY": "Ruyigi",
	"KH-2": "Baat Dambang",
	"KH-1": "Banteay Mean Choăy",
	"KH-23": "Kaeb",
	"KH-3": "Kampong Chaam",
	"KH-4": "Kampong Chhnang",
	"KH-5": "Kampong Spueu",
	"KH-6": "Kampong Thum",
	"KH-7": "Kampot",
	"KH-8": "Kandaal",
	"KH-9": "Kaoh Kong",
	"KH-10": "Kracheh",
	"KH-11": "Mondol Kiri",
	"KH-22": "Otdar Mean Chey",
	"KH-24": "Pailin",
	"KH-12": "Phnom Penh",
	"KH-15": "Pousaat",
	"KH-18": "Preah Sihanouk",
	"KH-13": "Preah Vihear",
	"KH-14": "Prey Veaeng",
	"KH-16": "Rotanak Kiri",
	"KH-17": "Siem Reab",
	"KH-19": "Stueng Traeng",
	"KH-20": "Svaay Rieng",
	"KH-21": "Taakaev",
	"KH-25": "Tbong Khmum",
	"CM-AD": "Adamaoua",
	"CM-CE": "Centre",
	"CM-ES": "East",
	"CM-EN": "Far North",
	"CM-LT": "Littoral",
	"CM-NO": "North",
	"CM-NW": "North-West",
	"CM-SU": "South",
	"CM-SW": "South-West",
	"CM-OU": "West",
	"CA-AB": "Alberta",
	"CA-BC": "British Columbia",
	"CA-MB": "Manitoba",
	"CA-NB": "New Brunswick",
	"CA-NL": "Newfoundland and Labrador",
	"CA-NT": "Northwest Territories",
	"CA-NS": "Nova Scotia",
	"CA-NU": "Nunavut",
	"CA-ON": "Ontario",
	"CA-PE": "Prince Edward Island",
	"CA-QC": "Quebec",
	"CA-SK": "Saskatchewan",
	"CA-YT": "Yukon",
	"CV-B": "Ilhas de Barlavento",
	"CV-S": "Ilhas de Sotavento",
	"CF-BB": "Bamingui-Bangoran",
	"CF-BGF": "Bangui",
	"CF-BK": "Basse-Kotto",
	"CF-KB": "Gribingui",
	"CF-HM": "Haut-Mbomou",
	"CF-HK": "Haute-Kotto",
	"CF-HS": "Haute-Sangha / Mambéré-Kadéï",
	"CF-KG": "Kémo-Gribingui",
	"CF-LB": "Lobaye",
	"CF-MB": "Mbomou",
	"CF-NM": "Nana-Mambéré",
	"CF-MP": "Ombella-Mpoko",
	"CF-UK": "Ouaka",
	"CF-AC": "Ouham",
	"CF-OP": "Ouham-Pendé",
	"CF-SE": "Sangha",
	"CF-VK": "Vakaga",
	"TD-BG": "Baḩr al Ghazāl",
	"TD-BA": "Al Baţḩā’",
	"TD-BO": "Būrkū",
	"TD-CB": "Shārī Bāqirmī",
	"TD-EE": "Inīdī ash Sharqī",
	"TD-EO": "Inīdī al Gharbī",
	"TD-GR": "Qīrā",
	"TD-HL": "Ḩajjar Lamīs",
	"TD-KA": "Kānim",
	"TD-LC": "Al Buḩayrah",
	"TD-LO": "Lūghūn al Gharbī",
	"TD-LR": "Lūghūn ash Sharqī",
	"TD-MA": "Māndūl",
	"TD-ME": "Māyū Kībbī ash Sharqī",
	"TD-MO": "Māyū Kībbī al Gharbī",
	"TD-MC": "Shārī al Awsaţ",
	"TD-OD": "Waddāy",
	"TD-SA": "Salāmāt",
	"TD-SI": "Sīlā",
	"TD-TA": "Tānjīlī",
	"TD-TI": "Tibastī",
	"TD-ND": "Madīnat Injamīnā",
	"TD-WF": "Wādī Fīrā’",
	"CL-AI": "Aisén del General Carlos Ibañez del Campo",
	"CL-AN": "Antofagasta",
	"CL-AP": "Arica y Parinacota",
	"CL-AT": "Atacama",
	"CL-BI": "Biobío",
	"CL-CO": "Coquimbo",
	"CL-AR": "La Araucanía",
	"CL-LI": "Libertador General Bernardo O'Higgins",
	"CL-LL": "Los Lagos",
	"CL-LR": "Los Ríos",
	"CL-MA": "Magallanes",
	"CL-ML": "Maule",
	"CL-NB": "Ñuble",
	"CL-RM": "Región Metropolitana de Santiago",
	"CL-TA": "Tarapacá",
	"CL-VS": "Valparaíso",
	"CN-AH": "Anhui Sheng",
	"CN-BJ": "Beijing Shi",
	"CN-CQ": "Chongqing Shi",
	"CN-FJ": "Fujian Sheng",
	"CN-GS": "Gansu Sheng",
	"CN-GD": "Guangdong Sheng",
	"CN-GX": "Guangxi Zhuangzu Zizhiqu",
	"CN-GZ": "Guizhou Sheng",
	"CN-HI": "Hainan Sheng",
	"CN-HE": "Hebei Sheng",
	"CN-HL": "Heilongjiang Sheng",
	"CN-HA": "Henan Sheng",
	"CN-HK": "Hong Kong SARen",
	"CN-HB": "Hubei Sheng",
	"CN-HN": "Hunan Sheng",
	"CN-JS": "Jiangsu Sheng",
	"CN-JX": "Jiangxi Sheng",
	"CN-JL": "Jilin Sheng",
	"CN-LN": "Liaoning Sheng",
	"CN-MO": "Macao SARpt",
	"CN-NM": "Nei Mongol Zizhiqu",
	"CN-NX": "Ningxia Huizu Zizhiqu",
	"CN-QH": "Qinghai Sheng",
	"CN-SN": "Shaanxi Sheng",
	"CN-SD": "Shandong Sheng",
	"CN-SH": "Shanghai Shi",
	"CN-SX": "Shanxi Sheng",
	"CN-SC": "Sichuan Sheng",
	"CN-TW": "Taiwan Sheng",
	"CN-TJ": "Tianjin Shi",
	"CN-XJ": "Xinjiang Uygur Zizhiqu",
	"CN-XZ": "Xizang Zizhiqu",
	"CN-YN": "Yunnan Sheng",
	"CN-ZJ": "Zhejiang Sheng",
	"CO-AMA": "Amazonas",
	"CO-ANT": "Antioquia",
	"CO-ARA": "Arauca",
	"CO-ATL": "Atlántico",
	"CO-BOL": "Bolívar",
	"CO-BOY": "Boyacá",
	"CO-CAL": "Caldas",
	"CO-CAQ": "Caquetá",
	"CO-CAS": "Casanare",
	"CO-CAU": "Cauca",
	"CO-CES": "Cesar",
	"CO-COR": "Córdoba",
	"CO-CUN": "Cundinamarca",
	"CO-CHO": "Chocó",
	"CO-DC": "Distrito Capital de Bogotá",
	"CO-GUA": "Guainía",
	"CO-GUV": "Guaviare",
	"CO-HUI": "Huila",
	"CO-LAG": "La Guajira",
	"CO-MAG": "Magdalena",
	"CO-MET": "Meta",
	"CO-NAR": "Nariño",
	"CO-NSA": "Norte de Santander",
	"CO-PUT": "Putumayo",
	"CO-QUI": "Quindío",
	"CO-RIS": "Risaralda",
	"CO-SAP": "San Andrés",
	"CO-SAN": "Santander",
	"CO-SUC": "Sucre",
	"CO-TOL": "Tolima",
	"CO-VAC": "Valle del Cauca",
	"CO-VAU": "Vaupés",
	"CO-VID": "Vichada",
	"KM-G": "Grande Comore",
	"KM-A": "Anjouan",
	"KM-M": "Mohéli",
	"CG-11": "Bouenza",
	"CG-BZV": "Brazzaville",
	"CG-8": "Cuvette",
	"CG-15": "Cuvette-Ouest",
	"CG-5": "Kouilou",
	"CG-2": "Lékoumou",
	"CG-7": "Likouala",
	"CG-9": "Niari",
	"CG-14": "Plateaux",
	"CG-16": "Pointe-Noire",
	"CG-12": "Pool",
	"CG-13": "Sangha",
	"CD-BU": "Bas-Uélé",
	"CD-EQ": "Équateur",
	"CD-HK": "Haut-Katanga",
	"CD-HL": "Haut-Lomami",
	"CD-HU": "Haut-Uélé",
	"CD-IT": "Ituri",
	"CD-KS": "Kasaï",
	"CD-KC": "Kasaï Central",
	"CD-KE": "Kasaï Oriental",
	"CD-KN": "Kinshasa",
	"CD-BC": "Kongo Central",
	"CD-KG": "Kwango",
	"CD-KL": "Kwilu",
	"CD-LO": "Lomami",
	"CD-LU": "Lualaba",
	"CD-MN": "Mai-Ndombe",
	"CD-MA": "Maniema",
	"CD-MO": "Mongala",
	"CD-NK": "Nord-Kivu",
	"CD-NU": "Nord-Ubangi",
	"CD-SA": "Sankuru",
	"CD-SK": "Sud-Kivu",
	"CD-SU": "Sud-Ubangi",
	"CD-TA": "Tanganyika",
	"CD-TO": "Tshopo",
	"CD-TU": "Tshuapa",
	"CR-A": "Alajuela",
	"CR-C": "Cartago",
	"CR-G": "Guanacaste",
	"CR-H": "Heredia",
	"CR-L": "Limón",
	"CR-P": "Puntarenas",
	"CR-SJ": "San José",
	"CI-AB": "Abidjan",
	"CI-BS": "Bas-Sassandra",
	"CI-CM": "Comoé",
	"CI-DN": "Denguélé",
	"CI-GD": "Gôh-Djiboua",
	"CI-LC": "Lacs",
	"CI-LG": "Lagunes",
	"CI-MG": "Montagnes",
	"CI-SM": "Sassandra-Marahoué",
	"CI-SV": "Savanes",
	"CI-VB": "Vallée du Bandama",
	"CI-WR": "Woroba",
	"CI-YM": "Yamoussoukro",
	"CI-ZZ": "Zanzan",
	"HR-07": "Bjelovarsko-bilogorska županija",
	"HR-12": "Brodsko-posavska županija",
	"HR-19": "Dubrovačko-neretvanska županija",
	"HR-21": "Grad Zagreb",
	"HR-18": "Istarska županija",
	"HR-04": "Karlovačka županija",
	"HR-06": "Koprivničko-križevačka županija",
	"HR-02": "Krapinsko-zagorska županija",
	"HR-09": "Ličko-senjska županija",
	"HR-20": "Međimurska županija",
	"HR-14": "Osječko-baranjska županija",
	"HR-11": "Požeško-slavonska županija",
	"HR-08": "Primorsko-goranska županija",
	"HR-03": "Sisačko-moslavačka županija",
	"HR-17": "Splitsko-dalmatinska županija",
	"HR-15": "Šibensko-kninska županija",
	"HR-05": "Varaždinska županija",
	"HR-10": "Virovitičko-podravska županija",
	"HR-16": "Vukovarsko-srijemska županija",
	"HR-13": "Zadarska županija",
	"HR-01": "Zagrebačka županija",
	"CU-15": "Artemisa",
	"CU-09": "Camagüey",
	"CU-08": "Ciego de Ávila",
	"CU-06": "Cienfuegos",
	"CU-12": "Granma",
	"CU-14": "Guantánamo",
	"CU-11": "Holguín",
	"CU-03": "La Habana",
	"CU-10": "Las Tunas",
	"CU-04": "Matanzas",
	"CU-16": "Mayabeque",
	"CU-01": "Pinar del Río",
	"CU-07": "Sancti Spíritus",
	"CU-13": "Santiago de Cuba",
	"CU-05": "Villa Clara",
	"CU-99": "Isla de la Juventud",
	"CY-04": "Ammochostos",
	"CY-06": "Keryneia",
	"CY-03": "Larnaka",
	"CY-01": "Lefkosia",
	"CY-02": "Lemesos",
	"CY-05": "Pafos",
	"CZ-31": "Jihočeský kraj",
	"CZ-64": "Jihomoravský kraj",
	"CZ-41": "Karlovarský kraj",
	"CZ-52": "Královéhradecký kraj",
	"CZ-51": "Liberecký kraj",
	"CZ-80": "Moravskoslezský kraj",
	"CZ-71": "Olomoucký kraj",
	"CZ-53": "Pardubický kraj",
	"CZ-32": "Plzeňský kraj",
	"CZ-10": "Praha",
	"CZ-20": "Středočeský kraj",
	"CZ-42": "Ústecký kraj",
	"CZ-63": "Kraj Vysočina",
	"CZ-72": "Zlínský kraj",
	"DK-84": "Region Hovedstaden",
	"DK-82": "Region Midjylland",
	"DK-81": "Region Nordjylland",
	"DK-85": "Region Sjælland",
	"DK-83": "Region Syddanmark",
	"DJ-AS": "Ali Sabieh",
	"DJ-AR": "Arta",
	"DJ-DI": "Dikhil",
	"DJ-DJ": "Djibouti",
	"DJ-OB": "Obock",
	"DJ-TA": "Tadjourah",
	"DM-02": "Saint Andrew",
	"DM-03": "Saint David",
	"DM-04": "Saint George",
	"DM-05": "Saint John",
	"DM-06": "Saint Joseph",
	"DM-07": "Saint Luke",
	"DM-08": "Saint Mark",
	"DM-09": "Saint Patrick",
	"DM-10": "Saint Paul",
	"DM-11": "Saint Peter",
	"DO-33": "Cibao Nordeste",
	"DO-34": "Cibao Noroeste",
	"DO-35": "Cibao Norte",
	"DO-36": "Cibao Sur",
	"DO-37": "El Valle",
	"DO-38": "Enriquillo",
	"DO-39": "Higuamo",
	"DO-40": "Ozama",
	"DO-41": "Valdesia",
	"DO-42": "Yuma",
	"EC-A": "Azuay",
	"EC-B": "Bolívar",
	"EC-F": "Cañar",
	"EC-C": "Carchi",
	"EC-H": "Chimborazo",
	"EC-X": "Cotopaxi",
	"EC-O": "El Oro",
	"EC-E": "Esmeraldas",
	"EC-W": "Galápagos",
	"EC-G": "Guayas",
	"EC-I": "Imbabura",
	"EC-L": "Loja",
	"EC-R": "Los Ríos",
	"EC-M": "Manabí",
	"EC-S": "Morona Santiago",
	"EC-N": "Napo",
	"EC-D": "Orellana",
	"EC-Y": "Pastaza",
	"EC-P": "Pichincha",
	"EC-SE": "Santa Elena",
	"EC-SD": "Santo Domingo de los Tsáchilas",
	"EC-U": "Sucumbíos",
	"EC-T": "Tungurahua",
	"EC-Z": "Zamora Chinchipe",
	"EG-DK": "Ad Daqahlīyah",
	"EG-BA": "Al Baḩr al Aḩmar",
	"EG-BH": "Al Buḩayrah",
	"EG-FYM": "Al Fayyūm",
	"EG-GH": "Al Gharbīyah",
	"EG-ALX": "Al Iskandarīyah",
	"EG-IS": "Al Ismā'īlīyah",
	"EG-GZ": "Al Jīzah",
	"EG-MNF": "Al Minūfīyah",
	"EG-MN": "Al Minyā",
	"EG-C": "Al Qāhirah",
	"EG-KB": "Al Qalyūbīyah",
	"EG-LX": "Al Uqşur",
	"EG-WAD": "Al Wādī al Jadīd",
	"EG-SUZ": "As Suways",
	"EG-SHR": "Ash Sharqīyah",
	"EG-ASN": "Aswān",
	"EG-AST": "Asyūţ",
	"EG-BNS": "Banī Suwayf",
	"EG-PTS": "Būr Sa‘īd",
	"EG-DT": "Dumyāţ",
	"EG-JS": "Janūb Sīnā'",
	"EG-KFS": "Kafr ash Shaykh",
	"EG-MT": "Maţrūḩ",
	"EG-KN": "Qinā",
	"EG-SIN": "Shamāl Sīnā'",
	"EG-SHG": "Sūhāj",
	"SV-AH": "Ahuachapán",
	"SV-CA": "Cabañas",
	"SV-CH": "Chalatenango",
	"SV-CU": "Cuscatlán",
	"SV-LI": "La Libertad",
	"SV-PA": "La Paz",
	"SV-UN": "La Unión",
	"SV-MO": "Morazán",
	"SV-SM": "San Miguel",
	"SV-SS": "San Salvador",
	"SV-SV": "San Vicente",
	"SV-SA": "Santa Ana",
	"SV-SO": "Sonsonate",
	"SV-US": "Usulután",
	"GQ-C": "Región Continental",
	"GQ-I": "Región Insular",
	"ER-MA": "Al Awsaţ",
	"ER-DU": "Al Janūbī",
	"ER-AN": "Ansabā",
	"ER-DK": "Janūbī al Baḩrī al Aḩmar",
	"ER-GB": "Qāsh-Barkah",
	"ER-SK": "Shimālī al Baḩrī al Aḩmar",
	"EE-37": "Harjumaa",
	"EE-39": "Hiiumaa",
	"EE-45": "Ida-Virumaa",
	"EE-50": "Jõgevamaa",
	"EE-52": "Järvamaa",
	"EE-60": "Lääne-Virumaa",
	"EE-56": "Läänemaa",
	"EE-64": "Põlvamaa",
	"EE-68": "Pärnumaa",
	"EE-71": "Raplamaa",
	"EE-74": "Saaremaa",
	"EE-79": "Tartumaa",
	"EE-81": "Valgamaa",
	"EE-84": "Viljandimaa",
	"EE-87": "Võrumaa",
	"ET-AA": "Ādīs Ābeba",
	"ET-AF": "Āfar",
	"ET-AM": "Āmara",
	"ET-BE": "Bīnshangul Gumuz",
	"ET-DD": "Dirē Dawa",
	"ET-GA": "Gambēla Hizboch",
	"ET-HA": "Hārerī Hizb",
	"ET-OR": "Oromīya",
	"ET-SI": "Sīdama",
	"ET-SO": "Sumalē",
	"ET-TI": "Tigray",
	"ET-SN": "YeDebub Bihēroch Bihēreseboch na Hizboch",
	"ET-SW": "YeDebub M‘irab Ītyop’iya Hizboch",
	"FJ-C": "Central",
	"FJ-E": "Eastern",
	"FJ-N": "Northern",
	"FJ-W": "Western",
	"FJ-R": "Rotuma",
	"FI-01": "Ahvenanmaan maakunta",
	"FI-02": "Etelä-Karjala",
	"FI-03": "Etelä-Pohjanmaa",
	"FI-04": "Etelä-Savo",
	"FI-05": "Kainuu",
	"FI-06": "Kanta-Häme",
	"FI-07": "Keski-Pohjanmaa",
	"FI-08": "Keski-Suomi",
	"FI-09": "Kymenlaakso",
	"FI-10": "Lappi",
	"FI-11": "Pirkanmaa",
	"FI-12": "Pohjanmaa",
	"FI-13": "Pohjois-Karjala",
	"FI-14": "Pohjois-Pohjanmaa",
	"FI-15": "Pohjois-Savo",
	"FI-16": "Päijät-Häme",
	"FI-17": "Satakunta",
	"FI-18": "Uusimaa",
	"FI-19": "Varsinais-Suomi",
	"FR-ARA": "Auvergne-Rhône-Alpes",
	"FR-BFC": "Bourgogne-Franche-Comté",
	"FR-BRE": "Bretagne",
	"FR-CVL": "Centre-Val de Loire",
	"FR-20R": "Corse",
	"FR-GES": "Grand Est",
	"FR-HDF": "Hauts-de-France",
	"FR-IDF": "Île-de-France",
	"FR-NOR": "Normandie",
	"FR-NAQ": "Nouvelle-Aquitaine",
	"FR-OCC": "Occitanie",
	"FR-PDL": "Pays-de-la-Loire",
	"FR-PAC": "Provence-Alpes-Côte-d’Azur",
	"GA-1": "Estuaire",
	"GA-2": "Haut-Ogooué",
	"GA-3": "Moyen-Ogooué",
	"GA-4": "Ngounié",
	"GA-5": "Nyanga",
	"GA-6": "Ogooué-Ivindo",
	"GA-7": "Ogooué-Lolo",
	"GA-8": "Ogooué-Maritime",
	"GA-9": "Woleu-Ntem",
	"GM-B": "Banjul",
	"GM-M": "Central River",
	"GM-L": "Lower River",
	"GM-N": "North Bank",
	"GM-U": "Upper River",
	"GM-W": "Western",
	"GE-AB": "Abkhazia",
	"GE-AJ": "Ajaria",
	"GE-GU": "Guria",
	"GE-IM": "Imereti",
	"GE-KA": "K'akheti",
	"GE-KK": "Kvemo Kartli",
	"GE-MM": "Mtskheta-Mtianeti",
	"GE-RL": "Rach'a-Lechkhumi-Kvemo Svaneti",
	"GE-SZ": "Samegrelo-Zemo Svaneti",
	"GE-SJ": "Samtskhe-Javakheti",
	"GE-SK": "Shida Kartli",
	"GE-TB": "Tbilisi",
	"DE-BW": "Baden-Württemberg",
	"DE-BY": "Bayern",
	"DE-BE": "Berlin",
	"DE-BB": "Brandenburg",
	"DE-HB": "Bremen",
	"DE-HH": "Hamburg",
	"DE-HE": "Hessen",
	"DE-MV": "Mecklenburg-Vorpommern",
	"DE-NI": "Niedersachsen",
	"DE-NW": "Nordrhein-Westfalen",
	"DE-RP": "Rheinland-Pfalz",
	"DE-SL": "Saarland",
	"DE-SN": "Sachsen",
	"DE-ST": "Sachsen-Anhalt",
	"DE-SH": "Schleswig-Holstein",
	"DE-TH": "Thüringen",
	"GH-AF": "Ahafo",
	"GH-AH": "Ashanti",
	"GH-BO": "Bono",
	"GH-BE": "Bono East",
	"GH-CP": "Central",
	"GH-EP": "Eastern",
	"GH-AA": "Greater Accra",
	"GH-NE": "North East",
	"GH-NP": "Northern",
	"GH-OT": "Oti",
	"GH-SV": "Savannah",
	"GH-UE": "Upper East",
	"GH-UW": "Upper West",
	"GH-TV": "Volta",
	"GH-WP": "Western",
	"GH-WN": "Western North",
	"GR-69": "Ágion Óros",
	"GR-A": "Anatolikí Makedonía kaiThráki",
	"GR-I": "Attikí",
	"GR-G": "Dytikí Elláda",
	"GR-C": "Dytikí Makedonía",
	"GR-F": "Ionía Nísia",
	"GR-D": "Ípeiros",
	"GR-B": "Kentrikí Makedonía",
	"GR-M": "Kríti",
	"GR-L": "Nótio Aigaío",
	"GR-J": "Pelopónnisos",
	"GR-H": "Stereá Elláda",
	"GR-E": "Thessalía",
	"GR-K": "Vóreio Aigaío",
	"GL-AV": "Avannaata Kommunia",
	"GL-KU": "Kommune Kujalleq",
	"GL-QT": "Kommune Qeqertalik",
	"GL-SM": "Kommuneqarfik Sermersooq",
	"GL-QE": "Qeqqata Kommunia",
	"GD-01": "Saint Andrew",
	"GD-02": "Saint David",
	"GD-03": "Saint George",
	"GD-04": "Saint John",
	"GD-05": "Saint Mark",
	"GD-06": "Saint Patrick",
	"GD-10": "Southern Grenadine Islands",
	"GT-16": "Alta Verapaz",
	"GT-15": "Baja Verapaz",
	"GT-04": "Chimaltenango",
	"GT-20": "Chiquimula",
	"GT-02": "El Progreso",
	"GT-05": "Escuintla",
	"GT-01": "Guatemala",
	"GT-13": "Huehuetenango",
	"GT-18": "Izabal",
	"GT-21": "Jalapa",
	"GT-22": "Jutiapa",
	"GT-17": "Petén",
	"GT-09": "Quetzaltenango",
	"GT-14": "Quiché",
	"GT-11": "Retalhuleu",
	"GT-03": "Sacatepéquez",
	"GT-12": "San Marcos",
	"GT-06": "Santa Rosa",
	"GT-07": "Sololá",
	"GT-10": "Suchitepéquez",
	"GT-08": "Totonicapán",
	"GT-19": "Zacapa",
	"GN-B": "Boké",
	"GN-F": "Faranah",
	"GN-K": "Kankan",
	"GN-D": "Kindia",
	"GN-L": "Labé",
	"GN-M": "Mamou",
	"GN-N": "Nzérékoré",
	"GN-C": "Conakry",
	"GW-L": "Leste",
	"GW-N": "Norte",
	"GW-S": "Sul",
	"GY-BA": "Barima-Waini",
	"GY-CU": "Cuyuni-Mazaruni",
	"GY-DE": "Demerara-Mahaica",
	"GY-EB": "East Berbice-Corentyne",
	"GY-ES": "Essequibo Islands-West Demerara",
	"GY-MA": "Mahaica-Berbice",
	"GY-PM": "Pomeroon-Supenaam",
	"GY-PT": "Potaro-Siparuni",
	"GY-UD": "Upper Demerara-Berbice",
	"GY-UT": "Upper Takutu-Upper Essequibo",
	"HT-AR": "Artibonite",
	"HT-CE": "Centre",
	"HT-GA": "Grande’Anse",
	"HT-NI": "Nippes",
	"HT-ND": "Nord",
	"HT-NE": "Nord-Est",
	"HT-NO": "Nord-Ouest",
	"HT-OU": "Ouest",
	"HT-SD": "Sud",
	"HT-SE": "Sud-Est",
	"HN-AT": "Atlántida",
	"HN-CH": "Choluteca",
	"HN-CL": "Colón",
	"HN-CM": "Comayagua",
	"HN-CP": "Copán",
	"HN-CR": "Cortés",
	"HN-EP": "El Paraíso",
	"HN-FM": "Francisco Morazán",
	"HN-GD": "Gracias a Dios",
	"HN-IN": "Intibucá",
	"HN-IB": "Islas de la Bahía",
	"HN-LP": "La Paz",
	"HN-LE": "Lempira",
	"HN-OC": "Ocotepeque",
	"HN-OL": "Olancho",
	"HN-SB": "Santa Bárbara",
	"HN-VA": "Valle",
	"HN-YO": "Yoro",
	"HU-BK": "Bács-Kiskun",
	"HU-BA": "Baranya",
	"HU-BE": "Békés",
	"HU-BC": "Békéscsaba",
	"HU-BZ": "Borsod-Abaúj-Zemplén",
	"HU-BU": "Budapest",
	"HU-CS": "Csongrád-Csanád",
	"HU-DE": "Debrecen",
	"HU-DU": "Dunaújváros",
	"HU-EG": "Eger",
	"HU-ER": "Érd",
	"HU-FE": "Fejér",
	"HU-GY": "Győr",
	"HU-GS": "Győr-Moson-Sopron",
	"HU-HB": "Hajdú-Bihar",
	"HU-HE": "Heves",
	"HU-HV": "Hódmezővásárhely",
	"HU-JN": "Jász-Nagykun-Szolnok",
	"HU-KV": "Kaposvár",
	"HU-KM": "Kecskemét",
	"HU-KE": "Komárom-Esztergom",
	"HU-MI": "Miskolc",
	"HU-NK": "Nagykanizsa",
	"HU-NO": "Nógrád",
	"HU-NY": "Nyíregyháza",
	"HU-PS": "Pécs",
	"HU-PE": "Pest",
	"HU-ST": "Salgótarján",
	"HU-SO": "Somogy",
	"HU-SN": "Sopron",
	"HU-SZ": "Szabolcs-Szatmár-Bereg",
	"HU-SD": "Szeged",
	"HU-SF": "Székesfehérvár",
	"HU-SS": "Szekszárd",
	"HU-SK": "Szolnok",
	"HU-SH": "Szombathely",
	"HU-TB": "Tatabánya",
	"HU-TO": "Tolna",
	"HU-VA": "Vas",
	"HU-VM": "Veszprém",
	"HU-VE": "Veszprém",
	"HU-ZA": "Zala",
	"HU-ZE": "Zalaegerszeg",
	"IS-7": "Austurland",
	"IS-1": "Höfuðborgarsvæði",
	"IS-6": "Norðurland eystra",
	"IS-5": "Norðurland vestra",
	"IS-8": "Suðurland",
	"IS-2": "Suðurnes",
	"IS-4": "Vestfirðir",
	"IS-3": "Vesturland",
	"IN-AN": "Andaman and Nicobar Islands",
	"IN-AP": "Andhra Pradesh",
	"IN-AR": "Arunāchal Pradesh",
	"IN-AS": "Assam",
	"IN-BR": "Bihār",
	"IN-CH": "Chandīgarh",
	"IN-CG": "Chhattīsgarh",
	"IN-DH": "Dādra and Nagar Haveli and Damān and Diu[1]",
	"IN-DL": "Delhi",
	"IN-GA": "Goa",
	"IN-GJ": "Gujarāt",
	"IN-HR": "Haryāna",
	"IN-HP": "Himāchal Pradesh",
	"IN-JK": "Jammu and Kashmīr",
	"IN-JH": "Jhārkhand",
	"IN-KA": "Karnātaka",
	"IN-KL": "Kerala",
	"IN-LA": "Ladākh",
	"IN-LD": "Lakshadweep",
	"IN-MP": "Madhya Pradesh",
	"IN-MH": "Mahārāshtra",
	"IN-MN": "Manipur",
	"IN-ML": "Meghālaya",
	"IN-MZ": "Mizoram",
	"IN-NL": "Nāgāland",
	"IN-OD": "Odisha",
	"IN-PY": "Puducherry",
	"IN-PB": "Punjab",
	"IN-RJ": "Rājasthān",
	"IN-SK": "Sikkim",
	"IN-TN": "Tamil Nādu",
	"IN-TS": "Telangāna[2]",
	"IN-TR": "Tripura",
	"IN-UP": "Uttar Pradesh",
	"IN-UK": "Uttarākhand",
	"IN-WB": "West Bengal",
	"ID-JW": "Jawa",
	"ID-KA": "Kalimantan",
	"ID-ML": "Maluku",
	"ID-NU": "Nusa Tenggara",
	"ID-PP": "Papua",
	"ID-SL": "Sulawesi",
	"ID-SM": "Sumatera",
	"IR-30": "Alborz",
	"IR-24": "Ardabīl",
	"IR-04": "Āz̄ārbāyjān-e Ghārbī",
	"IR-03": "Āz̄ārbāyjān-e Shārqī",
	"IR-18": "Būshehr",
	"IR-14": "Chahār Maḩāl va Bakhtīārī",
	"IR-10": "Eşfahān",
	"IR-07": "Fārs",
	"IR-01": "Gīlān",
	"IR-27": "Golestān",
	"IR-13": "Hamadān",
	"IR-22": "Hormozgān",
	"IR-16": "Īlām",
	"IR-08": "Kermān",
	"IR-05": "Kermānshāh",
	"IR-29": "Khorāsān-e Jonūbī",
	"IR-09": "Khorāsān-e Raẕavī",
	"IR-28": "Khorāsān-e Shomālī",
	"IR-06": "Khūzestān",
	"IR-17": "Kohgīlūyeh va Bowyer Aḩmad",
	"IR-12": "Kordestān",
	"IR-15": "Lorestān",
	"IR-00": "Markazī",
	"IR-02": "Māzandarān",
	"IR-26": "Qazvīn",
	"IR-25": "Qom",
	"IR-20": "Semnān",
	"IR-11": "Sīstān va Balūchestān",
	"IR-23": "Tehrān",
	"IR-21": "Yazd",
	"IR-19": "Zanjān",
	"IQ-AN": "Al Anbār",
	"IQ-BA": "Al Başrah",
	"IQ-MU": "Al Muthanná",
	"IQ-QA": "Al Qādisīyah",
	"IQ-NA": "An Najaf",
	"IQ-AR": "Arbīl",
	"IQ-SU": "As Sulaymānīyah",
	"IQ-BB": "Bābil",
	"IQ-BG": "Baghdād",
	"IQ-DA": "Dahūk",
	"IQ-DQ": "Dhī Qār",
	"IQ-DI": "Diyālá",
	"IQ-KR": "Iqlīm Kūrdistān",
	"IQ-KA": "Karbalā’",
	"IQ-KI": "Kirkūk",
	"IQ-MA": "Maysān",
	"IQ-NI": "Nīnawá",
	"IQ-SD": "Şalāḩ ad Dīn",
	"IQ-WA": "Wāsiţ",
	"IE-C": "Connaught",
	"IE-L": "Leinster",
	"IE-M": "Munster",
	"IE-U": "Ulster[a]",
	"IL-D": "HaDarom",
	"IL-M": "HaMerkaz",
	"IL-Z": "HaTsafon",
	"IL-HA": "H̱efa",
	"IL-TA": "Tel Aviv",
	"IL-JM": "Yerushalayim",
	"IT-65": "Abruzzo",
	"IT-77": "Basilicata",
	"IT-78": "Calabria",
	"IT-72": "Campania",
	"IT-45": "Emilia-Romagna",
	"IT-36": "Friuli Venezia Giulia",
	"IT-62": "Lazio",
	"IT-42": "Liguria",
	"IT-25": "Lombardia",
	"IT-57": "Marche",
	"IT-67": "Molise",
	"IT-21": "Piemonte",
	"IT-75": "Puglia",
	"IT-88": "Sardegna",
	"IT-82": "Sicilia",
	"IT-52": "Toscana",
	"IT-32": "Trentino-Alto Adigede",
	"IT-55": "Umbria",
	"IT-23": "Valle d'Aostafr",
	"IT-34": "Veneto",
	"JM-13": "Clarendon",
	"JM-09": "Hanover",
	"JM-01": "Kingston",
	"JM-12": "Manchester",
	"JM-04": "Portland",
	"JM-02": "Saint Andrew",
	"JM-06": "Saint Ann",
	"JM-14": "Saint Catherine",
	"JM-11": "Saint Elizabeth",
	"JM-08": "Saint James",
	"JM-05": "Saint Mary",
	"JM-03": "Saint Thomas",
	"JM-07": "Trelawny",
	"JM-10": "Westmoreland",
	"JP-23": "Aiti",
	"JP-05": "Akita",
	"JP-02": "Aomori",
	"JP-38": "Ehime",
	"JP-21": "Gihu",
	"JP-10": "Gunma",
	"JP-34": "Hirosima",
	"JP-01": "Hokkaidô",
	"JP-18": "Hukui",
	"JP-40": "Hukuoka",
	"JP-07": "Hukusima",
	"JP-28": "Hyôgo",
	"JP-08": "Ibaraki",
	"JP-17": "Isikawa",
	"JP-03": "Iwate",
	"JP-37": "Kagawa",
	"JP-46": "Kagosima",
	"JP-14": "Kanagawa",
	"JP-39": "Kôti",
	"JP-43": "Kumamoto",
	"JP-26": "Kyôto",
	"JP-24": "Mie",
	"JP-04": "Miyagi",
	"JP-45": "Miyazaki",
	"JP-20": "Nagano",
	"JP-42": "Nagasaki",
	"JP-29": "Nara",
	"JP-15": "Niigata",
	"JP-44": "Ôita",
	"JP-33": "Okayama",
	"JP-47": "Okinawa",
	"JP-27": "Ôsaka",
	"JP-41": "Saga",
	"JP-11": "Saitama",
	"JP-25": "Siga",
	"JP-32": "Simane",
	"JP-22": "Sizuoka",
	"JP-12": "Tiba",
	"JP-36": "Tokusima",
	"JP-13": "Tôkyô",
	"JP-09": "Totigi",
	"JP-31": "Tottori",
	"JP-16": "Toyama",
	"JP-30": "Wakayama",
	"JP-06": "Yamagata",
	"JP-35": "Yamaguti",
	"JP-19": "Yamanasi",
	"JO-AJ": "‘Ajlūn",
	"JO-AQ": "Al ‘Aqabah",
	"JO-AM": "Al ‘A̅şimah",
	"JO-BA": "Al Balqā’",
	"JO-KA": "Al Karak",
	"JO-MA": "Al Mafraq",
	"JO-AT": "Aţ Ţafīlah",
	"JO-AZ": "Az Zarqā’",
	"JO-IR": "Irbid",
	"JO-JA": "Jarash",
	"JO-MN": "Ma‘ān",
	"JO-MD": "Mādabā",
	"KZ-10": "Abayoblysy",
	"KZ-75": "Almaty",
	"KZ-19": "Almatyoblysy",
	"KZ-11": "Aqmola oblysy",
	"KZ-15": "Aqtöbe oblysy",
	"KZ-71": "Astana",
	"KZ-23": "Atyraūoblysy",
	"KZ-27": "Batys Qazaqstan oblysy",
	"KZ-47": "Mangghystaū oblysy",
	"KZ-55": "Pavlodar oblysy",
	"KZ-35": "Qaraghandy oblysy",
	"KZ-39": "Qostanay oblysy",
	"KZ-43": "Qyzylorda oblysy",
	"KZ-63": "Shyghys Qazaqstan oblysy",
	"KZ-79": "Shymkent",
	"KZ-59": "Soltüstik Qazaqstan oblysy",
	"KZ-61": "Türkistan oblysy",
	"KZ-62": "Ulytaūoblysy",
	"KZ-31": "Zhambyl oblysy",
	"KZ-33": "Zhetisū oblysy",
	"KE-01": "Baringo",
	"KE-02": "Bomet",
	"KE-03": "Bungoma",
	"KE-04": "Busia",
	"KE-05": "Elgeyo/Marakwet",
	"KE-06": "Embu",
	"KE-07": "Garissa",
	"KE-08": "Homa Bay",
	"KE-09": "Isiolo",
	"KE-10": "Kajiado",
	"KE-11": "Kakamega",
	"KE-12": "Kericho",
	"KE-13": "Kiambu",
	"KE-14": "Kilifi",
	"KE-15": "Kirinyaga",
	"KE-16": "Kisii",
	"KE-17": "Kisumu",
	"KE-18": "Kitui",
	"KE-19": "Kwale",
	"KE-20": "Laikipia",
	"KE-21": "Lamu",
	"KE-22": "Machakos",
	"KE-23": "Makueni",
	"KE-24": "Mandera",
	"KE-25": "Marsabit",
	"KE-26": "Meru",
	"KE-27": "Migori",
	"KE-28": "Mombasa",
	"KE-29": "Murang'a",
	"KE-30": "Nairobi City",
	"KE-31": "Nakuru",
	"KE-32": "Nandi",
	"KE-33": "Narok",
	"KE-34": "Nyamira",
	"KE-35": "Nyandarua",
	"KE-36": "Nyeri",
	"KE-37": "Samburu",
	"KE-38": "Siaya",
	"KE-39": "Taita/Taveta",
	"KE-40": "Tana River",
	"KE-41": "Tharaka-Nithi",
	"KE-42": "Trans Nzoia",
	"KE-43": "Turkana",
	"KE-44": "Uasin Gishu",
	"KE-45": "Vihiga",
	"KE-46": "Wajir",
	"KE-47": "West Pokot",
	"KI-G": "Gilbert Islands",
	"KI-L": "Line Islands",
	"KI-P": "Phoenix Islands",
	"KP-04": "Chagang-do",
	"KP-09": "Hamgyǒng-bukto",
	"KP-08": "Hamgyǒng-namdo",
	"KP-06": "Hwanghae-bukto",
	"KP-05": "Hwanghae-namdo",
	"KP-15": "Kaesŏng",
	"KP-07": "Kangwǒn-do",
	"KP-14": "Namp’o",
	"KP-03": "P'yǒngan-bukto",
	"KP-02": "P'yǒngan-namdo",
	"KP-01": "P'yǒngyang",
	"KP-13": "Rasǒn",
	"KP-10": "Ryanggang-do",
	"KR-26": "Busan-gwangyeoksi",
	"KR-43": "Chungcheongbuk-do",
	"KR-44": "Chungcheongnam-do",
	"KR-27": "Daegu-gwangyeoksi",
	"KR-30": "Daejeon-gwangyeoksi",
	"KR-42": "Gangwon-teukbyeoljachido",
	"KR-29": "Gwangju-gwangyeoksi",
	"KR-41": "Gyeonggi-do",
	"KR-47": "Gyeongsangbuk-do",
	"KR-48": "Gyeongsangnam-do",
	"KR-28": "Incheon-gwangyeoksi",
	"KR-49": "Jeju-teukbyeoljachido",
	"KR-45": "Jeollabuk-do",
	"KR-46": "Jeollanam-do",
	"KR-50": "Sejong",
	"KR-11": "Seoul-teukbyeolsi",
	"KR-31": "Ulsan-gwangyeoksi",
	"KW-AH": "Al Aḩmadī",
	"KW-FA": "Al Farwānīyah",
	"KW-JA": "Al Jahrā’",
	"KW-KU": "Al ‘Āşimah",
	"KW-HA": "Ḩawallī",
	"KW-MU": "Mubārak al Kabīr",
	"KG-B": "Batken",
	"KG-GB": "Bishkek Shaary",
	"KG-C": "Chüy",
	"KG-J": "Jalal-Abad",
	"KG-N": "Naryn",
	"KG-O": "Osh",
	"KG-GO": "Osh Shaary",
	"KG-T": "Talas",
	"KG-Y": "Ysyk-Köl",
	"LA-AT": "Attapu",
	"LA-BK": "Bokèo",
	"LA-BL": "Bolikhamxai",
	"LA-CH": "Champasak",
	"LA-HO": "Houaphan",
	"LA-KH": "Khammouan",
	"LA-LM": "Louang Namtha",
	"LA-LP": "Louangphabang",
	"LA-OU": "Oudômxai",
	"LA-PH": "Phôngsali",
	"LA-SL": "Salavan",
	"LA-SV": "Savannakhét",
	"LA-VI": "Viangchan",
	"LA-VT": "Viangchan",
	"LA-XA": "Xaignabouli",
	"LA-XS": "Xaisômboun",
	"LA-XE": "Xékong",
	"LA-XI": "Xiangkhouang",
	"LV-002": "Aizkraukles novads",
	"LV-007": "Alūksnes novads",
	"LV-111": "Augšdaugavas novads",
	"LV-011": "Ādažu novads",
	"LV-015": "Balvu novads",
	"LV-016": "Bauskas novads",
	"LV-022": "Cēsu novads",
	"LV-DGV": "Daugavpils",
	"LV-112": "Dienvidkurzemes Novads",
	"LV-026": "Dobeles novads",
	"LV-033": "Gulbenes novads",
	"LV-JEL": "Jelgava",
	"LV-041": "Jelgavas novads",
	"LV-042": "Jēkabpils novads",
	"LV-JUR": "Jūrmala",
	"LV-047": "Krāslavas novads",
	"LV-050": "Kuldīgas novads",
	"LV-052": "Ķekavas novads",
	"LV-LPX": "Liepāja",
	"LV-054": "Limbažu novads",
	"LV-056": "Līvānu novads",
	"LV-058": "Ludzas novads",
	"LV-059": "Madonas novads",
	"LV-062": "Mārupes novads",
	"LV-067": "Ogres novads",
	"LV-068": "Olaines novads",
	"LV-073": "Preiļu novads",
	"LV-REZ": "Rēzekne",
	"LV-077": "Rēzeknes novads",
	"LV-RIX": "Rīga",
	"LV-080": "Ropažu novads",
	"LV-087": "Salaspils novads",
	"LV-088": "Saldus novads",
	"LV-089": "Saulkrastu novads",
	"LV-091": "Siguldas novads",
	"LV-094": "Smiltenes novads",
	"LV-097": "Talsu novads",
	"LV-099": "Tukuma novads",
	"LV-101": "Valkas novads",
	"LV-113": "Valmieras Novads",
	"LV-102": "Varakļānu novads",
	"LV-VEN": "Ventspils",
	"LV-106": "Ventspils novads",
	"LB-AK": "Aakkâr",
	"LB-BH": "Baalbek-Hermel",
	"LB-BI": "Béqaa",
	"LB-BA": "Beyrouth",
	"LB-AS": "Liban-Nord",
	"LB-JA": "Liban-Sud",
	"LB-JL": "Mont-Liban",
	"LB-NA": "Nabatîyé",
	"LS-D": "Berea",
	"LS-B": "Botha-Bothe",
	"LS-C": "Leribe",
	"LS-E": "Mafeteng",
	"LS-A": "Maseru",
	"LS-F": "Mohale's Hoek",
	"LS-J": "Mokhotlong",
	"LS-H": "Qacha's Nek",
	"LS-G": "Quthing",
	"LS-K": "Thaba-Tseka",
	"LR-BM": "Bomi",
	"LR-BG": "Bong",
	"LR-GP": "Gbarpolu",
	"LR-GB": "Grand Bassa",
	"LR-CM": "Grand Cape Mount",
	"LR-GG": "Grand Gedeh",
	"LR-GK": "Grand Kru",
	"LR-LO": "Lofa",
	"LR-MG": "Margibi",
	"LR-MY": "Maryland",
	"LR-MO": "Montserrado",
	"LR-NI": "Nimba",
	"LR-RI": "River Cess",
	"LR-RG": "River Gee",
	"LR-SI": "Sinoe",
	"LY-BU": "Al Buţnān",
	"LY-JA": "Al Jabal al Akhḑar",
	"LY-JG": "Al Jabal al Gharbī",
	"LY-JI": "Al Jafārah",
	"LY-JU": "Al Jufrah",
	"LY-KF": "Al Kufrah",
	"LY-MJ": "Al Marj",
	"LY-MB": "Al Marqab",
	"LY-WA": "Al Wāḩāt",
	"LY-NQ": "An Nuqāţ al Khams",
	"LY-ZA": "Az Zāwiyah",
	"LY-BA": "Banghāzī",
	"LY-DR": "Darnah",
	"LY-GT": "Ghāt",
	"LY-MI": "Mişrātah",
	"LY-MQ": "Murzuq",
	"LY-NL": "Nālūt",
	"LY-SB": "Sabhā",
	"LY-SR": "Surt",
	"LY-TB": "Ţarābulus",
	"LY-WD": "Wādī al Ḩayāt",
	"LY-WS": "Wādī ash Shāţi’",
	"LI-01": "Balzers",
	"LI-02": "Eschen",
	"LI-03": "Gamprin",
	"LI-04": "Mauren",
	"LI-05": "Planken",
	"LI-06": "Ruggell",
	"LI-07": "Schaan",
	"LI-08": "Schellenberg",
	"LI-09": "Triesen",
	"LI-10": "Triesenberg",
	"LI-11": "Vaduz",
	"LT-AL": "Alytaus apskritis",
	"LT-KU": "Kauno apskritis",
	"LT-KL": "Klaipėdos apskritis",
	"LT-MR": "Marijampolės apskritis",
	"LT-PN": "Panevėžio apskritis",
	"LT-SA": "Šiaulių apskritis",
	"LT-TA": "Tauragės apskritis",
	"LT-TE": "Telšių apskritis",
	"LT-UT": "Utenos apskritis",
	"LT-VL": "Vilniaus apskritis",
	"LU-CA": "Capellen",
	"LU-CL": "Clervaux",
	"LU-DI": "Diekirch",
	"LU-EC": "Echternach",
	"LU-ES": "Esch-sur-Alzette",
	"LU-GR": "Grevenmacher",
	"LU-LU": "Luxembourg",
	"LU-ME": "Mersch",
	"LU-RD": "Redange",
	"LU-RM": "Remich",
	"LU-VD": "Vianden",
	"LU-WI": "Wiltz",
	"MG-T": "Antananarivo",
	"MG-D": "Antsiranana",
	"MG-F": "Fianarantsoa",
	"MG-M": "Mahajanga",
	"MG-A": "Toamasina",
	"MG-U": "Toliara",
	"MW-N": "Chakumpoto",
	"MW-S": "Chakumwera",
	"MW-C": "Chapakati",
	"MY-01": "Johor",
	"MY-02": "Kedah",
	"MY-03": "Kelantan",
	"MY-04": "Melaka",
	"MY-05": "Negeri Sembilan",
	"MY-06": "Pahang",
	"MY-08": "Perak",
	"MY-09": "Perlis",
	"MY-07": "Pulau Pinang",
	"MY-12": "Sabah",
	"MY-13": "Sarawak",
	"MY-10": "Selangor",
	"MY-11": "Terengganu",
	"MY-14": "Wilayah Persekutuan Kuala Lumpur",
	"MY-15": "Wilayah Persekutuan Labuan",
	"MY-16": "Wilayah Persekutuan Putrajaya",
	"MV-01": "Addu",
	"MV-00": "Ariatholhu Dhekunuburi",
	"MV-02": "Ariatholhu Uthuruburi",
	"MV-03": "Faadhippolhu",
	"MV-04": "Felidheatholhu",
	"MV-29": "Fuvammulah",
	"MV-05": "Hahdhunmathi",
	"MV-28": "Huvadhuatholhu Dhekunuburi",
	"MV-27": "Huvadhuatholhu Uthuruburi",
	"MV-08": "Kolhumadulu",
	"MV-MLE": "Maale",
	"MV-26": "Maaleatholhu",
	"MV-20": "Maalhosmadulu Dhekunuburi",
	"MV-13": "Maalhosmadulu Uthuruburi",
	"MV-25": "Miladhunmadulu Dhekunuburi",
	"MV-24": "Miladhunmadulu Uthuruburi",
	"MV-12": "Mulakatholhu",
	"MV-17": "Nilandheatholhu Dhekunuburi",
	"MV-14": "Nilandheatholhu Uthuruburi",
	"MV-23": "Thiladhunmathee Dhekunuburi",
	"MV-07": "Thiladhunmathee Uthuruburi",
	"ML-BKO": "Bamako",
	"ML-7": "Gao",
	"ML-1": "Kayes",
	"ML-8": "Kidal",
	"ML-2": "Koulikoro",
	"ML-9": "Ménaka",
	"ML-5": "Mopti",
	"ML-4": "Ségou",
	"ML-3": "Sikasso",
	"ML-10": "Taoudénit",
	"ML-6": "Tombouctou",
	"MT-01": "Attard",
	"MT-02": "Balzan",
	"MT-03": "Birgu",
	"MT-04": "Birkirkara",
	"MT-05": "Birżebbuġa",
	"MT-06": "Bormla",
	"MT-07": "Dingli",
	"MT-08": "Fgura",
	"MT-09": "Floriana",
	"MT-10": "Fontana",
	"MT-11": "Gudja",
	"MT-12": "Gżira",
	"MT-13": "Għajnsielem",
	"MT-14": "Għarb",
	"MT-15": "Għargħur",
	"MT-16": "Għasri",
	"MT-17": "Għaxaq",
	"MT-18": "Ħamrun",
	"MT-19": "Iklin",
	"MT-20": "Isla",
	"MT-21": "Kalkara",
	"MT-22": "Kerċem",
	"MT-23": "Kirkop",
	"MT-24": "Lija",
	"MT-25": "Luqa",
	"MT-26": "Marsa",
	"MT-27": "Marsaskala",
	"MT-28": "Marsaxlokk",
	"MT-29": "Mdina",
	"MT-30": "Mellieħa",
	"MT-31": "Mġarr",
	"MT-32": "Mosta",
	"MT-33": "Mqabba",
	"MT-34": "Msida",
	"MT-35": "Mtarfa",
	"MT-36": "Munxar",
	"MT-37": "Nadur",
	"MT-38": "Naxxar",
	"MT-39": "Paola",
	"MT-40": "Pembroke",
	"MT-41": "Pietà",
	"MT-42": "Qala",
	"MT-43": "Qormi",
	"MT-44": "Qrendi",
	"MT-45": "Rabat Għawdex",
	"MT-46": "Rabat Malta",
	"MT-47": "Safi",
	"MT-48": "San Ġiljan",
	"MT-49": "San Ġwann",
	"MT-50": "San Lawrenz",
	"MT-51": "San Pawl il-Baħar",
	"MT-52": "Sannat",
	"MT-53": "Santa Luċija",
	"MT-54": "Santa Venera",
	"MT-55": "Siġġiewi",
	"MT-56": "Sliema",
	"MT-57": "Swieqi",
	"MT-58": "Ta' Xbiex",
	"MT-59": "Tarxien",
	"MT-60": "Valletta",
	"MT-61": "Xagħra",
	"MT-62": "Xewkija",
	"MT-63": "Xgħajra",
	"MT-64": "Żabbar",
	"MT-65": "Żebbuġ Għawdex",
	"MT-66": "Żebbuġ Malta",
	"MT-67": "Żejtun",
	"MT-68": "Żurrieq",
	"MH-L": "Ralik chain",
	"MH-T": "Ratak chain",
	"MR-07": "Adrar",
	"MR-03": "Assaba",
	"MR-05": "Brakna",
	"MR-08": "Dakhlet Nouâdhibou",
	"MR-04": "Gorgol",
	"MR-10": "Guidimaka",
	"MR-01": "Hodh ech Chargui",
	"MR-02": "Hodh el Gharbi",
	"MR-12": "Inchiri",
	"MR-09": "Tagant",
	"MR-11": "Tiris Zemmour",
	"MR-06": "Trarza",
	"MU-AG": "Agalega Islands",
	"MU-BL": "Black River",
	"MU-CC": "Cargados Carajos Shoals",
	"MU-FL": "Flacq",
	"MU-GP": "Grand Port",
	"MU-MO": "Moka",
	"MU-PA": "Pamplemousses",
	"MU-PW": "Plaines Wilhems",
	"MU-PL": "Port Louis",
	"MU-RR": "Rivière du Rempart",
	"MU-RO": "Rodrigues Island",
	"MU-SA": "Savanne",
	"MX-AGU": "Aguascalientes",
	"MX-BCN": "Baja California",
	"MX-BCS": "Baja California Sur",
	"MX-CAM": "Campeche",
	"MX-CMX": "Ciudad de México",
	"MX-COA": "Coahuila de Zaragoza",
	"MX-COL": "Colima",
	"MX-CHP": "Chiapas",
	"MX-CHH": "Chihuahua",
	"MX-DUR": "Durango",
	"MX-GUA": "Guanajuato",
	"MX-GRO": "Guerrero",
	"MX-HID": "Hidalgo",
	"MX-JAL": "Jalisco",
	"MX-MEX": "México",
	"MX-MIC": "Michoacán de Ocampo",
	"MX-MOR": "Morelos",
	"MX-NAY": "Nayarit",
	"MX-NLE": "Nuevo León",
	"MX-OAX": "Oaxaca",
	"MX-PUE": "Puebla",
	"MX-QUE": "Querétaro",
	"MX-ROO": "Quintana Roo",
	"MX-SLP": "San Luis Potosí",
	"MX-SIN": "Sinaloa",
	"MX-SON": "Sonora",
	"MX-TAB": "Tabasco",
	"MX-TAM": "Tamaulipas",
	"MX-TLA": "Tlaxcala",
	"MX-VER": "Veracruz de Ignacio de la Llave",
	"MX-YUC": "Yucatán",
	"MX-ZAC": "Zacatecas",
	"FM-TRK": "Chuuk",
	"FM-KSA": "Kosrae",
	"FM-PNI": "Pohnpei",
	"FM-YAP": "Yap",
	"MD-AN": "Anenii Noi",
	"MD-BS": "Basarabeasca",
	"MD-BA": "Bălți",
	"MD-BD": "Bender",
	"MD-BR": "Briceni",
	"MD-CA": "Cahul",
	"MD-CT": "Cantemir",
	"MD-CL": "Călărași",
	"MD-CS": "Căușeni",
	"MD-CU": "Chișinău",
	"MD-CM": "Cimișlia",
	"MD-CR": "Criuleni",
	"MD-DO": "Dondușeni",
	"MD-DR": "Drochia",
	"MD-DU": "Dubăsari",
	"MD-ED": "Edineț",
	"MD-FA": "Fălești",
	"MD-FL": "Florești",
	"MD-GA": "Găgăuzia",
	"MD-GL": "Glodeni",
	"MD-HI": "Hîncești",
	"MD-IA": "Ialoveni",
	"MD-LE": "Leova",
	"MD-NI": "Nisporeni",
	"MD-OC": "Ocnița",
	"MD-OR": "Orhei",
	"MD-RE": "Rezina",
	"MD-RI": "Rîșcani",
	"MD-SI": "Sîngerei",
	"MD-SO": "Soroca",
	"MD-SN": "Stînga Nistrului",
	"MD-ST": "Strășeni",
	"MD-SD": "Șoldănești",
	"MD-SV": "Ștefan Vodă",
	"MD-TA": "Taraclia",
	"MD-TE": "Telenești",
	"MD-UN": "Ungheni",
	"MC-FO": "Fontvieille",
	"MC-JE": "Jardin Exotique",
	"MC-CL": "La Colle",
	"MC-CO": "La Condamine",
	"MC-GA": "La Gare",
	"MC-SO": "La Source",
	"MC-LA": "Larvotto",
	"MC-MA": "Malbousquet",
	"MC-MO": "Monaco-Ville",
	"MC-MG": "Moneghetti",
	"MC-MC": "Monte-Carlo",
	"MC-MU": "Moulins",
	"MC-PH": "Port-Hercule",
	"MC-SR": "Saint-Roman",
	"MC-SD": "Sainte-Dévote",
	"MC-SP": "Spélugues",
	"MC-VR": "Vallon de la Rousse",
	"MN-073": "Arhangay",
	"MN-069": "Bayanhongor",
	"MN-071": "Bayan-Ölgiy",
	"MN-067": "Bulgan",
	"MN-037": "Darhan uul",
	"MN-061": "Dornod",
	"MN-063": "Dornogovĭ",
	"MN-059": "Dundgovĭ",
	"MN-057": "Dzavhan",
	"MN-065": "Govĭ-Altay",
	"MN-064": "Govĭ-Sümber",
	"MN-039": "Hentiy",
	"MN-043": "Hovd",
	"MN-041": "Hövsgöl",
	"MN-053": "Ömnögovĭ",
	"MN-035": "Orhon",
	"MN-055": "Övörhangay",
	"MN-049": "Selenge",
	"MN-051": "Sühbaatar",
	"MN-047": "Töv",
	"MN-1": "Ulaanbaatar",
	"MN-046": "Uvs",
	"MA-05": "Béni Mellal-Khénifra",
	"MA-06": "Casablanca-Settat",
	"MA-12": "Dakhla-Oued Ed-Dahab",
	"MA-08": "Drâa-Tafilalet",
	"MA-03": "Fès-Meknès",
	"MA-10": "Guelmim-Oued Noun",
	"MA-02": "L'Oriental",
	"MA-11": "Laâyoune-Sakia El Hamra",
	"MA-07": "Marrakech-Safi",
	"MA-04": "Rabat-Salé-Kénitra",
	"MA-09": "Souss-Massa",
	"MA-01": "Tanger-Tétouan-Al Hoceïma",
	"MZ-P": "Cabo Delgado",
	"MZ-G": "Gaza",
	"MZ-I": "Inhambane",
	"MZ-B": "Manica",
	"MZ-MPM": "Maputo",
	"MZ-L": "Maputo",
	"MZ-N": "Nampula",
	"MZ-A": "Niassa",
	"MZ-S": "Sofala",
	"MZ-T": "Tete",
	"MZ-Q": "Zambézia",
	"MM-07": "Ayeyarwady",
	"MM-02": "Bago",
	"MM-14": "Chin",
	"MM-11": "Kachin",
	"MM-12": "Kayah",
	"MM-13": "Kayin",
	"MM-03": "Magway",
	"MM-04": "Mandalay",
	"MM-15": "Mon",
	"MM-18": "Nay Pyi Taw",
	"MM-16": "Rakhine",
	"MM-01": "Sagaing",
	"MM-17": "Shan",
	"MM-05": "Tanintharyi",
	"MM-06": "Yangon",
	"NA-ER": "Erongo",
	"NA-HA": "Hardap",
	"NA-KA": "//Karas",
	"NA-KE": "Kavango East",
	"NA-KW": "Kavango West",
	"NA-KH": "Khomas",
	"NA-KU": "Kunene",
	"NA-OW": "Ohangwena",
	"NA-OH": "Omaheke",
	"NA-OS": "Omusati",
	"NA-ON": "Oshana",
	"NA-OT": "Oshikoto",
	"NA-OD": "Otjozondjupa",
	"NA-CA": "Zambezi",
	"NR-01": "Aiwo",
	"NR-02": "Anabar",
	"NR-03": "Anetan",
	"NR-04": "Anibare",
	"NR-05": "Baitsi",
	"NR-06": "Boe",
	"NR-07": "Buada",
	"NR-08": "Denigomodu",
	"NR-09": "Ewa",
	"NR-10": "Ijuw",
	"NR-11": "Meneng",
	"NR-12": "Nibok",
	"NR-13": "Uaboe",
	"NR-14": "Yaren",
	"NP-P3": "Bāgmatī",
	"NP-P4": "Gaṇḍakī",
	"NP-P6": "Karṇālī",
	"NP-P1": "Koshī",
	"NP-P5": "Lumbinī",
	"NP-P2": "Madhesh",
	"NP-P7": "Sudūrpashchim",
	"NL-DR": "Drenthe",
	"NL-FL": "Flevoland",
	"NL-FR": "Fryslânfy",
	"NL-GE": "Gelderland",
	"NL-GR": "Groningen",
	"NL-LI": "Limburg",
	"NL-NB": "Noord-Brabant",
	"NL-NH": "Noord-Holland",
	"NL-OV": "Overijssel",
	"NL-UT": "Utrecht",
	"NL-ZE": "Zeeland",
	"NL-ZH": "Zuid-Holland",
	"NZ-AUK": "Auckland",
	"NZ-BOP": "Bay of Plenty",
	"NZ-CAN": "Canterbury",
	"NZ-CIT": "Chatham Islands Territory",
	"NZ-GIS": "Gisborne",
	"NZ-WGN": "Greater Wellington",
	"NZ-HKB": "Hawke's Bay",
	"NZ-MWT": "Manawatū-Whanganui",
	"NZ-MBH": "Marlborough",
	"NZ-NSN": "Nelson",
	"NZ-NTL": "Northland",
	"NZ-OTA": "Otago",
	"NZ-STL": "Southland",
	"NZ-TKI": "Taranaki",
	"NZ-TAS": "Tasman",
	"NZ-WKO": "Waikato",
	"NZ-WTC": "West Coast",
	"NI-BO": "Boaco",
	"NI-CA": "Carazo",
	"NI-CI": "Chinandega",
	"NI-CO": "Chontales",
	"NI-AN": "Costa Caribe Norte",
	"NI-AS": "Costa Caribe Sur",
	"NI-ES": "Estelí",
	"NI-GR": "Granada",
	"NI-JI": "Jinotega",
	"NI-LE": "León",
	"NI-MD": "Madriz",
	"NI-MN": "Managua",
	"NI-MS": "Masaya",
	"NI-MT": "Matagalpa",
	"NI-NS": "Nueva Segovia",
	"NI-SJ": "Río San Juan",
	"NI-RI": "Rivas",
	"NE-1": "Agadez",
	"NE-2": "Diffa",
	"NE-3": "Dosso",
	"NE-4": "Maradi",
	"NE-8": "Niamey",
	"NE-5": "Tahoua",
	"NE-6": "Tillabéri",
	"NE-7": "Zinder",
	"NG-AB": "Abia",
	"NG-FC": "Abuja Federal Capital Territory",
	"NG-AD": "Adamawa",
	"NG-AK": "Akwa Ibom",
	"NG-AN": "Anambra",
	"NG-BA": "Bauchi",
	"NG-BY": "Bayelsa",
	"NG-BE": "Benue",
	"NG-BO": "Borno",
	"NG-CR": "Cross River",
	"NG-DE": "Delta",
	"NG-EB": "Ebonyi",
	"NG-ED": "Edo",
	"NG-EK": "Ekiti",
	"NG-EN": "Enugu",
	"NG-GO": "Gombe",
	"NG-IM": "Imo",
	"NG-JI": "Jigawa",
	"NG-KD": "Kaduna",
	"NG-KN": "Kano",
	"NG-KT": "Katsina",
	"NG-KE": "Kebbi",
	"NG-KO": "Kogi",
	"NG-KW": "Kwara",
	"NG-LA": "Lagos",
	"NG-NA": "Nasarawa",
	"NG-NI": "Niger",
	"NG-OG": "Ogun",
	"NG-ON": "Ondo",
	"NG-OS": "Osun",
	"NG-OY": "Oyo",
	"NG-PL": "Plateau",
	"NG-RI": "Rivers",
	"NG-SO": "Sokoto",
	"NG-TA": "Taraba",
	"NG-YO": "Yobe",
	"NG-ZA": "Zamfara",
	"MK-801": "Aerodrom",
	"MK-802": "Aračinovo",
	"MK-201": "Berovo",
	"MK-501": "Bitola",
	"MK-401": "Bogdanci",
	"MK-601": "Bogovinje",
	"MK-402": "Bosilovo",
	"MK-602": "Brvenica",
	"MK-803": "Butel",
	"MK-814": "Centar",
	"MK-313": "Centar Župa",
	"MK-815": "Čair",
	"MK-109": "Čaška",
	"MK-210": "Češinovo-Obleševo",
	"MK-816": "Čučer-Sandevo",
	"MK-303": "Debar",
	"MK-304": "Debrca",
	"MK-203": "Delčevo",
	"MK-502": "Demir Hisar",
	"MK-103": "Demir Kapija",
	"MK-406": "Dojran",
	"MK-503": "Dolneni",
	"MK-804": "Gazi Baba",
	"MK-405": "Gevgelija",
	"MK-805": "Gjorče Petrov",
	"MK-604": "Gostivar",
	"MK-102": "Gradsko",
	"MK-807": "Ilinden",
	"MK-606": "Jegunovce",
	"MK-205": "Karbinci",
	"MK-808": "Karpoš",
	"MK-104": "Kavadarci",
	"MK-307": "Kičevo",
	"MK-809": "Kisela Voda",
	"MK-206": "Kočani",
	"MK-407": "Konče",
	"MK-701": "Kratovo",
	"MK-702": "Kriva Palanka",
	"MK-504": "Krivogaštani",
	"MK-505": "Kruševo",
	"MK-703": "Kumanovo",
	"MK-704": "Lipkovo",
	"MK-105": "Lozovo",
	"MK-207": "Makedonska Kamenica",
	"MK-308": "Makedonski Brod",
	"MK-607": "Mavrovo i Rostuše",
	"MK-506": "Mogila",
	"MK-106": "Negotino",
	"MK-507": "Novaci",
	"MK-408": "Novo Selo",
	"MK-310": "Ohrid",
	"MK-208": "Pehčevo",
	"MK-810": "Petrovec",
	"MK-311": "Plasnica",
	"MK-508": "Prilep",
	"MK-209": "Probištip",
	"MK-409": "Radoviš",
	"MK-705": "Rankovce",
	"MK-509": "Resen",
	"MK-107": "Rosoman",
	"MK-811": "Saraj",
	"MK-812": "Sopište",
	"MK-706": "Staro Nagoričane",
	"MK-312": "Struga",
	"MK-410": "Strumica",
	"MK-813": "Studeničani",
	"MK-108": "Sveti Nikole",
	"MK-211": "Štip",
	"MK-817": "Šuto Orizari",
	"MK-608": "Tearce",
	"MK-609": "Tetovo",
	"MK-403": "Valandovo",
	"MK-404": "Vasilevo",
	"MK-101": "Veles",
	"MK-301": "Vevčani",
	"MK-202": "Vinica",
	"MK-603": "Vrapčište",
	"MK-806": "Zelenikovo",
	"MK-204": "Zrnovci",
	"MK-605": "Želino",
	"NO-42": "Agder",
	"NO-34": "Innlandet",
	"NO-22": "Jan Mayen",
	"NO-15": "Møre og Romsdal",
	"NO-18": "Nordland",
	"NO-03": "Oslo",
	"NO-11": "Rogaland",
	"NO-21": "Svalbard",
	"NO-54": "Troms og Finnmarksefkv",
	"NO-50": "Trøndelagsma",
	"NO-38": "Vestfold og Telemark",
	"NO-46": "Vestland",
	"NO-30": "Viken",
	"OM-DA": "Ad Dākhilīyah",
	"OM-BU": "Al Buraymī",
	"OM-WU": "Al Wusţá",
	"OM-ZA": "Az̧ Z̧āhirah",
	"OM-BJ": "Janūb al Bāţinah",
	"OM-SJ": "Janūb ash Sharqīyah",
	"OM-MA": "Masqaţ",
	"OM-MU": "Musandam",
	"OM-BS": "Shamāl al Bāţinah",
	"OM-SS": "Shamāl ash Sharqīyah",
	"OM-ZU": "Z̧ufār",
	"PK-JK": "Āzād Jammūñ o Kashmīr",
	"PK-BA": "Balōchistān",
	"PK-GB": "Gilgit-Baltistān",
	"PK-IS": "Islāmābād",
	"PK-KP": "Khaībar Pakhtūnkhwā",
	"PK-PB": "Panjāb",
	"PK-SD": "Sindh",
	"PW-002": "Aimeliik",
	"PW-004": "Airai",
	"PW-010": "Angaur",
	"PW-050": "Hatohobei",
	"PW-100": "Kayangel",
	"PW-150": "Koror",
	"PW-212": "Melekeok",
	"PW-214": "Ngaraard",
	"PW-218": "Ngarchelong",
	"PW-222": "Ngardmau",
	"PW-224": "Ngatpang",
	"PW-226": "Ngchesar",
	"PW-227": "Ngeremlengui",
	"PW-228": "Ngiwal",
	"PW-350": "Peleliu",
	"PW-370": "Sonsorol",
	"PS-BTH": "Bayt Laḩm",
	"PS-DEB": "Dayr al Balaḩ",
	"PS-GZA": "Ghazzah",
	"PS-HBN": "Al Khalīl",
	"PS-JEN": "Janīn",
	"PS-JRH": "Arīḩā wal Aghwār",
	"PS-JEM": "Al Quds",
	"PS-KYS": "Khān Yūnis",
	"PS-NBS": "Nāblus",
	"PS-NGZ": "Shamāl Ghazzah",
	"PS-QQA": "Qalqīlyah",
	"PS-RFH": "Rafaḩ",
	"PS-RBH": "Rām Allāh wal Bīrah",
	"PS-SLT": "Salfīt",
	"PS-TBS": "Ţūbās",
	"PS-TKM": "Ţūlkarm",
	"PA-1": "Bocas del Toro",
	"PA-4": "Chiriquí",
	"PA-2": "Coclé",
	"PA-3": "Colón",
	"PA-5": "Darién",
	"PA-EM": "Emberá",
	"PA-KY": "Guna Yala",
	"PA-6": "Herrera",
	"PA-7": "Los Santos",
	"PA-NT": "Naso Tjër Di",
	"PA-NB": "Ngäbe-Buglé",
	"PA-8": "Panamá",
	"PA-10": "Panamá Oeste",
	"PA-9": "Veraguas",
	"PG-NSB": "Bougainville",
	"PG-CPM": "Central",
	"PG-CPK": "Chimbu",
	"PG-EBR": "East New Britain",
	"PG-ESW": "East Sepik",
	"PG-EHG": "Eastern Highlands",
	"PG-EPW": "Enga",
	"PG-GPK": "Gulf",
	"PG-HLA": "Hela",
	"PG-JWK": "Jiwaka",
	"PG-MPM": "Madang",
	"PG-MRL": "Manus",
	"PG-MBA": "Milne Bay",
	"PG-MPL": "Morobe",
	"PG-NCD": "National Capital District",
	"PG-NIK": "New Ireland",
	"PG-NPP": "Northern",
	"PG-SHM": "Southern Highlands",
	"PG-WBK": "West New Britain",
	"PG-SAN": "West Sepik",
	"PG-WPD": "Western",
	"PG-WHM": "Western Highlands",
	"PY-16": "Alto Paraguay",
	"PY-10": "Alto Paraná",
	"PY-13": "Amambay",
	"PY-ASU": "Asunción",
	"PY-19": "Boquerón",
	"PY-5": "Caaguazú",
	"PY-6": "Caazapá",
	"PY-14": "Canindeyú",
	"PY-11": "Central",
	"PY-1": "Concepción",
	"PY-3": "Cordillera",
	"PY-4": "Guairá",
	"PY-7": "Itapúa",
	"PY-8": "Misiones",
	"PY-12": "Ñeembucú",
	"PY-9": "Paraguarí",
	"PY-15": "Presidente Hayes",
	"PY-2": "San Pedro",
	"PE-AMA": "Amazonas",
	"PE-ANC": "Ancash",
	"PE-APU": "Apurímac",
	"PE-ARE": "Arequipa",
	"PE-AYA": "Ayacucho",
	"PE-CAJ": "Cajamarca",
	"PE-CUS": "Cusco",
	"PE-CAL": "El Callao",
	"PE-HUV": "Huancavelica",
	"PE-HUC": "Huánuco",
	"PE-ICA": "Ica",
	"PE-JUN": "Junín",
	"PE-LAL": "La Libertad",
	"PE-LAM": "Lambayeque",
	"PE-LIM": "Lima",
	"PE-LOR": "Loreto",
	"PE-MDD": "Madre de Dios",
	"PE-MOQ": "Moquegua",
	"PE-LMA": "Municipalidad Metropolitana de Lima",
	"PE-PAS": "Pasco",
	"PE-PIU": "Piura",
	"PE-PUN": "Puno",
	"PE-SAM": "San Martín",
	"PE-TAC": "Tacna",
	"PE-TUM": "Tumbes",
	"PE-UCA": "Ucayali",
	"PH-14": "Autonomous Region in Muslim Mindanao[b]",
	"PH-05": "Bicol",
	"PH-02": "Cagayan Valley",
	"PH-40": "Calabarzon",
	"PH-13": "Caraga",
	"PH-03": "Central Luzon",
	"PH-07": "Central Visayas",
	"PH-15": "Cordillera Administrative Region",
	"PH-11": "Davao",
	"PH-08": "Eastern Visayas",
	"PH-01": "Ilocos",
	"PH-41": "Mimaropa",
	"PH-00": "National Capital Region",
	"PH-10": "Northern Mindanao",
	"PH-12": "Soccsksargen",
	"PH-06": "Western Visayas",
	"PH-09": "Zamboanga Peninsula",
	"PL-02": "Dolnośląskie",
	"PL-04": "Kujawsko-Pomorskie",
	"PL-06": "Lubelskie",
	"PL-08": "Lubuskie",
	"PL-10": "Łódzkie",
	"PL-12": "Małopolskie",
	"PL-14": "Mazowieckie",
	"PL-16": "Opolskie",
	"PL-18": "Podkarpackie",
	"PL-20": "Podlaskie",
	"PL-22": "Pomorskie",
	"PL-24": "Śląskie",
	"PL-26": "Świętokrzyskie",
	"PL-28": "Warmińsko-Mazurskie",
	"PL-30": "Wielkopolskie",
	"PL-32": "Zachodniopomorskie",
	"PT-01": "Aveiro",
	"PT-02": "Beja",
	"PT-03": "Braga",
	"PT-04": "Bragança",
	"PT-05": "Castelo Branco",
	"PT-06": "Coimbra",
	"PT-07": "Évora",
	"PT-08": "Faro",
	"PT-09": "Guarda",
	"PT-10": "Leiria",
	"PT-11": "Lisboa",
	"PT-12": "Portalegre",
	"PT-13": "Porto",
	"PT-30": "Região Autónoma da Madeira",
	"PT-20": "Região Autónoma dos Açores",
	"PT-14": "Santarém",
	"PT-15": "Setúbal",
	"PT-16": "Viana do Castelo",
	"PT-17": "Vila Real",
	"PT-18": "Viseu",
	"QA-DA": "Ad Dawḩah",
	"QA-KH": "Al Khawr wa adh Dhakhīrah",
	"QA-WA": "Al Wakrah",
	"QA-RA": "Ar Rayyān",
	"QA-MS": "Ash Shamāl",
	"QA-SH": "Ash Shīḩānīyah",
	"QA-ZA": "Az̧ Z̧a‘āyin",
	"QA-US": "Umm Şalāl",
	"RO-AB": "Alba",
	"RO-AR": "Arad",
	"RO-AG": "Argeș",
	"RO-BC": "Bacău",
	"RO-BH": "Bihor",
	"RO-BN": "Bistrița-Năsăud",
	"RO-BT": "Botoșani",
	"RO-BV": "Brașov",
	"RO-BR": "Brăila",
	"RO-B": "București",
	"RO-BZ": "Buzău",
	"RO-CS": "Caraș-Severin",
	"RO-CL": "Călărași",
	"RO-CJ": "Cluj",
	"RO-CT": "Constanța",
	"RO-CV": "Covasna",
	"RO-DB": "Dâmbovița",
	"RO-DJ": "Dolj",
	"RO-GL": "Galați",
	"RO-GR": "Giurgiu",
	"RO-GJ": "Gorj",
	"RO-HR": "Harghita",
	"RO-HD": "Hunedoara",
	"RO-IL": "Ialomița",
	"RO-IS": "Iași",
	"RO-IF": "Ilfov",
	"RO-MM": "Maramureș",
	"RO-MH": "Mehedinți",
	"RO-MS": "Mureș",
	"RO-NT": "Neamț",
	"RO-OT": "Olt",
	"RO-PH": "Prahova",
	"RO-SM": "Satu Mare",
	"RO-SJ": "Sălaj",
	"RO-SB": "Sibiu",
	"RO-SV": "Suceava",
	"RO-TR": "Teleorman",
	"RO-TM": "Timiș",
	"RO-TL": "Tulcea",
	"RO-VS": "Vaslui",
	"RO-VL": "Vâlcea",
	"RO-VN": "Vrancea",
	"RU-AD": "Adygeya",
	"RU-AL": "Altay",
	"RU-ALT": "Altayskiy kray",
	"RU-AMU": "Amurskaya oblast'",
	"RU-ARK": "Arkhangel'skaya oblast'",
	"RU-AST": "Astrakhanskaya oblast'",
	"RU-BA": "Bashkortostan",
	"RU-BEL": "Belgorodskaya oblast'",
	"RU-BRY": "Bryanskaya oblast'",
	"RU-BU": "Buryatiya",
	"RU-CE": "Chechenskaya Respublika",
	"RU-CHE": "Chelyabinskaya oblast'",
	"RU-CHU": "Chukotskiy avtonomnyy okrug",
	"RU-CU": "Chuvashskaya Respublika",
	"RU-DA": "Dagestan",
	"RU-IN": "Ingushetiya",
	"RU-IRK": "Irkutskaya oblast'",
	"RU-IVA": "Ivanovskaya oblast'",
	"RU-KB": "Kabardino-BalkarskayaRespublika",
	"RU-KGD": "Kaliningradskaya oblast'",
	"RU-KL": "Kalmykiya",
	"RU-KLU": "Kaluzhskaya oblast'",
	"RU-KAM": "Kamchatskiy kray",
	"RU-KC": "Karachayevo-CherkesskayaRespublika",
	"RU-KR": "Kareliya",
	"RU-KEM": "Kemerovskaya oblast'",
	"RU-KHA": "Khabarovskiy kray",
	"RU-KK": "Khakasiya",
	"RU-KHM": "Khanty-Mansiyskiyavtonomnyy okrug",
	"RU-KIR": "Kirovskaya oblast'",
	"RU-KO": "Komi",
	"RU-KOS": "Kostromskaya oblast'",
	"RU-KDA": "Krasnodarskiy kray",
	"RU-KYA": "Krasnoyarskiy kray",
	"RU-KGN": "Kurganskaya oblast'",
	"RU-KRS": "Kurskaya oblast'",
	"RU-LEN": "Leningradskayaoblast'",
	"RU-LIP": "Lipetskaya oblast'",
	"RU-MAG": "Magadanskaya oblast'",
	"RU-ME": "Mariy El",
	"RU-MO": "Mordoviya",
	"RU-MOS": "Moskovskaya oblast'",
	"RU-MOW": "Moskva",
	"RU-MUR": "Murmanskaya oblast'",
	"RU-NEN": "Nenetskiyavtonomnyy okrug",
	"RU-NIZ": "Nizhegorodskaya oblast'",
	"RU-NGR": "Novgorodskaya oblast'",
	"RU-NVS": "Novosibirskayaoblast'",
	"RU-OMS": "Omskaya oblast'",
	"RU-ORE": "Orenburgskaya oblast'",
	"RU-ORL": "Orlovskaya oblast'",
	"RU-PNZ": "Penzenskaya oblast'",
	"RU-PER": "Permskiy kray",
	"RU-PRI": "Primorskiy kray",
	"RU-PSK": "Pskovskaya oblast'",
	"RU-ROS": "Rostovskaya oblast'",
	"RU-RYA": "Ryazanskaya oblast'",
	"RU-SA": "Saha",
	"RU-SAK": "Sakhalinskaya oblast'",
	"RU-SAM": "Samarskaya oblast'",
	"RU-SPE": "Sankt-Peterburg",
	"RU-SAR": "Saratovskaya oblast'",
	"RU-SE": "Severnaya Osetiya",
	"RU-SMO": "Smolenskaya oblast'",
	"RU-STA": "Stavropol'skiy kray",
	"RU-SVE": "Sverdlovskaya oblast'",
	"RU-TAM": "Tambovskaya oblast'",
	"RU-TA": "Tatarstan",
	"RU-TOM": "Tomskaya oblast'",
	"RU-TUL": "Tul'skaya oblast'",
	"RU-TVE": "Tverskaya oblast'",
	"RU-TYU": "Tyumenskaya oblast'",
	"RU-TY": "Tyva",
	"RU-UD": "Udmurtskaya Respublika",
	"RU-ULY": "Ul'yanovskaya oblast'",
	"RU-VLA": "Vladimirskayaoblast'",
	"RU-VGG": "Volgogradskayaoblast'",
	"RU-VLG": "Vologodskaya oblast'",
	"RU-VOR": "Voronezhskaya oblast'",
	"RU-YAN": "Yamalo-Nenetskiyavtonomnyy okrug",
	"RU-YAR": "Yaroslavskaya oblast'",
	"RU-YEV": "Yevreyskaya avtonomnaya oblast'",
	"RU-ZAB": "Zabaykal'skiy kray",
	"RW-01": "City of Kigali",
	"RW-02": "Eastern",
	"RW-03": "Northern",
	"RW-05": "Southern",
	"RW-04": "Western",
	"SH-AC": "Ascension",
	"SH-HL": "Saint Helena",
	"SH-TA": "Tristan da Cunha",
	"KN-K": "Saint Kitts",
	"KN-N": "Nevis",
	"LC-01": "Anse la Raye",
	"LC-12": "Canaries",
	"LC-02": "Castries",
	"LC-03": "Choiseul",
	"LC-05": "Dennery",
	"LC-06": "Gros Islet",
	"LC-07": "Laborie",
	"LC-08": "Micoud",
	"LC-10": "Soufrière",
	"LC-11": "Vieux Fort",
	"VC-01": "Charlotte",
	"VC-06": "Grenadines",
	"VC-02": "Saint Andrew",
	"VC-03": "Saint David",
	"VC-04": "Saint George",
	"VC-05": "Saint Patrick",
	"WS-AA": "A'ana",
	"WS-AL": "Aiga-i-le-Tai",
	"WS-AT": "Atua",
	"WS-FA": "Fa'asaleleaga",
	"WS-GE": "Gaga'emauga",
	"WS-GI": "Gagaifomauga",
	"WS-PA": "Palauli",
	"WS-SA": "Satupa'itea",
	"WS-TU": "Tuamasaga",
	"WS-VF": "Va'a-o-Fonoti",
	"WS-VS": "Vaisigano",
	"SM-01": "Acquaviva",
	"SM-06": "Borgo Maggiore",
	"SM-02": "Chiesanuova",
	"SM-07": "Città di San Marino",
	"SM-03": "Domagnano",
	"SM-04": "Faetano",
	"SM-05": "Fiorentino",
	"SM-08": "Montegiardino",
	"SM-09": "Serravalle",
	"ST-01": "Água Grande",
	"ST-02": "Cantagalo",
	"ST-03": "Caué",
	"ST-04": "Lembá",
	"ST-05": "Lobata",
	"ST-06": "Mé-Zóchi",
	"ST-P": "Príncipe",
	"SA-14": "'Asīr",
	"SA-11": "Al Bāḩah",
	"SA-08": "Al Ḩudūd ash Shamālīyah",
	"SA-12": "Al Jawf",
	"SA-03": "Al Madīnah al Munawwarah",
	"SA-05": "Al Qaşīm",
	"SA-01": "Ar Riyāḑ",
	"SA-04": "Ash Sharqīyah",
	"SA-06": "Ḩā'il",
	"SA-09": "Jāzān",
	"SA-02": "Makkah al Mukarramah",
	"SA-10": "Najrān",
	"SA-07": "Tabūk",
	"SN-DK": "Dakar",
	"SN-DB": "Diourbel",
	"SN-FK": "Fatick",
	"SN-KA": "Kaffrine",
	"SN-KL": "Kaolack",
	"SN-KE": "Kédougou",
	"SN-KD": "Kolda",
	"SN-LG": "Louga",
	"SN-MT": "Matam",
	"SN-SL": "Saint-Louis",
	"SN-SE": "Sédhiou",
	"SN-TC": "Tambacounda",
	"SN-TH": "Thiès",
	"SN-ZG": "Ziguinchor",
	"SC-01": "Anse aux Pins",
	"SC-02": "Anse Boileau",
	"SC-03": "Anse Etoile",
	"SC-05": "Anse Royale",
	"SC-04": "Au Cap",
	"SC-06": "Baie Lazare",
	"SC-07": "Baie Sainte Anne",
	"SC-08": "Beau Vallon",
	"SC-09": "Bel Air",
	"SC-10": "Bel Ombre",
	"SC-11": "Cascade",
	"SC-16": "English River",
	"SC-12": "Glacis",
	"SC-13": "Grand Anse Mahe",
	"SC-14": "Grand Anse Praslin",
	"SC-26": "Ile Perseverance I",
	"SC-27": "Ile Perseverance II",
	"SC-15": "La Digue",
	"SC-24": "Les Mamelles",
	"SC-17": "Mont Buxton",
	"SC-18": "Mont Fleuri",
	"SC-19": "Plaisance",
	"SC-20": "Pointe Larue",
	"SC-21": "Port Glaud",
	"SC-25": "Roche Caiman",
	"SC-22": "Saint Louis",
	"SC-23": "Takamaka",
	"SL-E": "Eastern",
	"SL-NW": "North Western",
	"SL-N": "Northern",
	"SL-S": "Southern",
	"SL-W": "Western Area",
	"SG-01": "Central Singapore",
	"SG-02": "North East",
	"SG-03": "North West",
	"SG-04": "South East",
	"SG-05": "South West",
	"SK-BC": "Banskobystrický kraj",
	"SK-BL": "Bratislavský kraj",
	"SK-KI": "Košický kraj",
	"SK-NI": "Nitriansky kraj",
	"SK-PV": "Prešovský kraj",
	"SK-TC": "Trenčiansky kraj",
	"SK-TA": "Trnavský kraj",
	"SK-ZI": "Žilinský kraj",
	"SI-001": "Ajdovščina",
	"SI-213": "Ankaran",
	"SI-195": "Apače",
	"SI-002": "Beltinci",
	"SI-148": "Benedikt",
	"SI-149": "Bistrica ob Sotli",
	"SI-003": "Bled",
	"SI-150": "Bloke",
	"SI-004": "Bohinj",
	"SI-005": "Borovnica",
	"SI-006": "Bovec",
	"SI-151": "Braslovče",
	"SI-007": "Brda",
	"SI-008": "Brezovica",
	"SI-009": "Brežice",
	"SI-152": "Cankova",
	"SI-011": "Celje",
	"SI-012": "Cerklje na Gorenjskem",
	"SI-013": "Cerknica",
	"SI-014": "Cerkno",
	"SI-153": "Cerkvenjak",
	"SI-196": "Cirkulane",
	"SI-015": "Črenšovci",
	"SI-016": "Črna na Koroškem",
	"SI-017": "Črnomelj",
	"SI-018": "Destrnik",
	"SI-019": "Divača",
	"SI-154": "Dobje",
	"SI-020": "Dobrepolje",
	"SI-155": "Dobrna",
	"SI-021": "Dobrova-Polhov Gradec",
	"SI-156": "Dobrovnik",
	"SI-022": "Dol pri Ljubljani",
	"SI-157": "Dolenjske Toplice",
	"SI-023": "Domžale",
	"SI-024": "Dornava",
	"SI-025": "Dravograd",
	"SI-026": "Duplek",
	"SI-027": "Gorenja vas-Poljane",
	"SI-028": "Gorišnica",
	"SI-207": "Gorje",
	"SI-029": "Gornja Radgona",
	"SI-030": "Gornji Grad",
	"SI-031": "Gornji Petrovci",
	"SI-158": "Grad",
	"SI-032": "Grosuplje",
	"SI-159": "Hajdina",
	"SI-160": "Hoče-Slivnica",
	"SI-161": "Hodoš",
	"SI-162": "Horjul",
	"SI-034": "Hrastnik",
	"SI-035": "Hrpelje-Kozina",
	"SI-036": "Idrija",
	"SI-037": "Ig",
	"SI-038": "Ilirska Bistrica",
	"SI-039": "Ivančna Gorica",
	"SI-040": "Izola",
	"SI-041": "Jesenice",
	"SI-163": "Jezersko",
	"SI-042": "Juršinci",
	"SI-043": "Kamnik",
	"SI-044": "Kanal ob Soči",
	"SI-045": "Kidričevo",
	"SI-046": "Kobarid",
	"SI-047": "Kobilje",
	"SI-048": "Kočevje",
	"SI-049": "Komen",
	"SI-164": "Komenda",
	"SI-050": "Koper",
	"SI-197": "Kostanjevica na Krki",
	"SI-165": "Kostel",
	"SI-051": "Kozje",
	"SI-052": "Kranj",
	"SI-053": "Kranjska Gora",
	"SI-166": "Križevci",
	"SI-054": "Krško",
	"SI-055": "Kungota",
	"SI-056": "Kuzma",
	"SI-057": "Laško",
	"SI-058": "Lenart",
	"SI-059": "Lendava",
	"SI-060": "Litija",
	"SI-061": "Ljubljana",
	"SI-062": "Ljubno",
	"SI-063": "Ljutomer",
	"SI-208": "Log-Dragomer",
	"SI-064": "Logatec",
	"SI-065": "Loška dolina",
	"SI-066": "Loški Potok",
	"SI-167": "Lovrenc na Pohorju",
	"SI-067": "Luče",
	"SI-068": "Lukovica",
	"SI-069": "Majšperk",
	"SI-198": "Makole",
	"SI-070": "Maribor",
	"SI-168": "Markovci",
	"SI-071": "Medvode",
	"SI-072": "Mengeš",
	"SI-073": "Metlika",
	"SI-074": "Mežica",
	"SI-169": "Miklavž na Dravskem polju",
	"SI-075": "Miren-Kostanjevica",
	"SI-212": "Mirna",
	"SI-170": "Mirna Peč",
	"SI-076": "Mislinja",
	"SI-199": "Mokronog-Trebelno",
	"SI-077": "Moravče",
	"SI-078": "Moravske Toplice",
	"SI-079": "Mozirje",
	"SI-080": "Murska Sobota",
	"SI-081": "Muta",
	"SI-082": "Naklo",
	"SI-083": "Nazarje",
	"SI-084": "Nova Gorica",
	"SI-085": "Novo Mesto",
	"SI-086": "Odranci",
	"SI-171": "Oplotnica",
	"SI-087": "Ormož",
	"SI-088": "Osilnica",
	"SI-089": "Pesnica",
	"SI-090": "Piran",
	"SI-091": "Pivka",
	"SI-092": "Podčetrtek",
	"SI-172": "Podlehnik",
	"SI-093": "Podvelka",
	"SI-200": "Poljčane",
	"SI-173": "Polzela",
	"SI-094": "Postojna",
	"SI-174": "Prebold",
	"SI-095": "Preddvor",
	"SI-175": "Prevalje",
	"SI-096": "Ptuj",
	"SI-097": "Puconci",
	"SI-098": "Rače-Fram",
	"SI-099": "Radeče",
	"SI-100": "Radenci",
	"SI-101": "Radlje ob Dravi",
	"SI-102": "Radovljica",
	"SI-103": "Ravne na Koroškem",
	"SI-176": "Razkrižje",
	"SI-209": "Rečica ob Savinji",
	"SI-201": "Renče-Vogrsko",
	"SI-104": "Ribnica",
	"SI-177": "Ribnica na Pohorju",
	"SI-106": "Rogaška Slatina",
	"SI-105": "Rogašovci",
	"SI-107": "Rogatec",
	"SI-108": "Ruše",
	"SI-178": "Selnica ob Dravi",
	"SI-109": "Semič",
	"SI-110": "Sevnica",
	"SI-111": "Sežana",
	"SI-112": "Slovenj Gradec",
	"SI-113": "Slovenska Bistrica",
	"SI-114": "Slovenske Konjice",
	"SI-179": "Sodražica",
	"SI-180": "Solčava",
	"SI-202": "Središče ob Dravi",
	"SI-115": "Starše",
	"SI-203": "Straža",
	"SI-181": "Sveta Ana",
	"SI-204": "Sveta Trojica v Slovenskih goricah",
	"SI-182": "Sveti Andraž v Slovenskih goricah",
	"SI-116": "Sveti Jurij ob Ščavnici",
	"SI-210": "Sveti Jurij v Slovenskih goricah",
	"SI-205": "Sveti Tomaž",
	"SI-033": "Šalovci",
	"SI-183": "Šempeter-Vrtojba",
	"SI-117": "Šenčur",
	"SI-118": "Šentilj",
	"SI-119": "Šentjernej",
	"SI-120": "Šentjur",
	"SI-211": "Šentrupert",
	"SI-121": "Škocjan",
	"SI-122": "Škofja Loka",
	"SI-123": "Škofljica",
	"SI-124": "Šmarje pri Jelšah",
	"SI-206": "Šmarješke Toplice",
	"SI-125": "Šmartno ob Paki",
	"SI-194": "Šmartno pri Litiji",
	"SI-126": "Šoštanj",
	"SI-127": "Štore",
	"SI-184": "Tabor",
	"SI-010": "Tišina",
	"SI-128": "Tolmin",
	"SI-129": "Trbovlje",
	"SI-130": "Trebnje",
	"SI-185": "Trnovska Vas",
	"SI-186": "Trzin",
	"SI-131": "Tržič",
	"SI-132": "Turnišče",
	"SI-133": "Velenje",
	"SI-187": "Velika Polana",
	"SI-134": "Velike Lašče",
	"SI-188": "Veržej",
	"SI-135": "Videm",
	"SI-136": "Vipava",
	"SI-137": "Vitanje",
	"SI-138": "Vodice",
	"SI-139": "Vojnik",
	"SI-189": "Vransko",
	"SI-140": "Vrhnika",
	"SI-141": "Vuzenica",
	"SI-142": "Zagorje ob Savi",
	"SI-143": "Zavrč",
	"SI-144": "Zreče",
	"SI-190": "Žalec",
	"SI-146": "Železniki",
	"SI-191": "Žetale",
	"SI-147": "Žiri",
	"SI-192": "Žirovnica",
	"SI-193": "Žužemberk",
	"SB-CT": "Capital Territory",
	"SB-CE": "Central",
	"SB-CH": "Choiseul",
	"SB-GU": "Guadalcanal",
	"SB-IS": "Isabel",
	"SB-MK": "Makira-Ulawa",
	"SB-ML": "Malaita",
	"SB-RB": "Rennell and Bellona",
	"SB-TE": "Temotu",
	"SB-WE": "Western",
	"SO-AW": "Awdal",
	"SO-BK": "Bakool",
	"SO-BN": "Banaadir",
	"SO-BR": "Bari",
	"SO-BY": "Bay",
	"SO-GA": "Galguduud",
	"SO-GE": "Gedo",
	"SO-HI": "Hiiraan",
	"SO-JD": "Jubbada Dhexe",
	"SO-JH": "Jubbada Hoose",
	"SO-MU": "Mudug",
	"SO-NU": "Nugaal",
	"SO-SA": "Sanaag",
	"SO-SD": "Shabeellaha Dhexe",
	"SO-SH": "Shabeellaha Hoose",
	"SO-SO": "Sool",
	"SO-TO": "Togdheer",
	"SO-WO": "Woqooyi Galbeed",
	"ZA-EC": "Eastern Cape",
	"ZA-FS": "Free State",
	"ZA-GP": "Gauteng",
	"ZA-KZN": "Kwazulu-Natal",
	"ZA-LP": "Limpopo",
	"ZA-MP": "Mpumalanga",
	"ZA-NW": "North-West",
	"ZA-NC": "Northern Cape",
	"ZA-WC": "Western Cape",
	"ES-AN": "Andalucía",
	"ES-AR": "Aragón",
	"ES-AS": "Asturias",
	"ES-CN": "Canarias",
	"ES-CB": "Cantabria",
	"ES-CL": "Castilla y León",
	"ES-CM": "Castilla-La Mancha",
	"ES-CT": "Catalunya",
	"ES-CE": "Ceuta",
	"ES-EX": "Extremadura",
	"ES-GA": "Galicia",
	"ES-IB": "Illes Balears",
	"ES-RI": "La Rioja",
	"ES-MD": "Madrid",
	"ES-ML": "Melilla",
	"ES-MC": "Murcia",
	"ES-NC": "Navarra",
	"ES-PV": "País Vasco",
	"ES-VC": "Valenciana",
	"LK-1": "Basnāhira paḷāta",
	"LK-3": "Dakuṇu paḷāta",
	"LK-2": "Madhyama paḷāta",
	"LK-5": "Næ̆gĕnahira paḷāta",
	"LK-9": "Sabaragamuva paḷāta",
	"LK-4": "Uturu paḷāta",
	"LK-7": "Uturumæ̆da paḷāta",
	"LK-8": "Ūva paḷāta",
	"LK-6": "Vayamba paḷāta",
	"SD-RS": "Al Baḩr al Aḩmar",
	"SD-GZ": "Al Jazīrah",
	"SD-KH": "Al Kharţūm",
	"SD-GD": "Al Qaḑārif",
	"SD-NW": "An Nīl al Abyaḑ",
	"SD-NB": "An Nīl al Azraq",
	"SD-NO": "Ash Shamālīyah",
	"SD-DW": "Gharb Dārfūr",
	"SD-GK": "Gharb Kurdufān",
	"SD-DS": "Janūb Dārfūr",
	"SD-KS": "Janūb Kurdufān",
	"SD-KA": "Kassalā",
	"SD-NR": "Nahr an Nīl",
	"SD-DN": "Shamāl Dārfūr",
	"SD-KN": "Shamāl Kurdufān",
	"SD-DE": "Sharq Dārfūr",
	"SD-SI": "Sinnār",
	"SD-DC": "Wasaţ Dārfūr",
	"SR-BR": "Brokopondo",
	"SR-CM": "Commewijne",
	"SR-CR": "Coronie",
	"SR-MA": "Marowijne",
	"SR-NI": "Nickerie",
	"SR-PR": "Para",
	"SR-PM": "Paramaribo",
	"SR-SA": "Saramacca",
	"SR-SI": "Sipaliwini",
	"SR-WA": "Wanica",
	"SZ-HH": "Hhohho",
	"SZ-LU": "Lubombo",
	"SZ-MA": "Manzini",
	"SZ-SH": "Shiselweni",
	"SE-K": "Blekinge län",
	"SE-W": "Dalarnas län",
	"SE-I": "Gotlands län",
	"SE-X": "Gävleborgs län",
	"SE-N": "Hallands län",
	"SE-Z": "Jämtlands län",
	"SE-F": "Jönköpings län",
	"SE-H": "Kalmar län",
	"SE-G": "Kronobergs län",
	"SE-BD": "Norrbottens län",
	"SE-M": "Skåne län",
	"SE-AB": "Stockholms län",
	"SE-D": "Södermanlands län",
	"SE-C": "Uppsala län",
	"SE-S": "Värmlands län",
	"SE-AC": "Västerbottens län",
	"SE-Y": "Västernorrlands län",
	"SE-U": "Västmanlands län",
	"SE-O": "Västra Götalands län",
	"SE-T": "Örebro län",
	"SE-E": "Östergötlands län",
	"CH-AG": "Aargau",
	"CH-AR": "Appenzell Ausserrhoden",
	"CH-AI": "Appenzell Innerrhoden",
	"CH-BL": "Basel-Landschaft",
	"CH-BS": "Basel-Stadt",
	"CH-BE": "Bern",
	"CH-FR": "Fribourg",
	"CH-GE": "Genève",
	"CH-GL": "Glarus",
	"CH-GR": "Graubünden",
	"CH-JU": "Jura",
	"CH-LU": "Luzern",
	"CH-NE": "Neuchâtel",
	"CH-NW": "Nidwalden",
	"CH-OW": "Obwalden",
	"CH-SG": "Sankt Gallen",
	"CH-SH": "Schaffhausen",
	"CH-SZ": "Schwyz",
	"CH-SO": "Solothurn",
	"CH-TG": "Thurgau",
	"CH-TI": "Ticino",
	"CH-UR": "Uri",
	"CH-VS": "Valais",
	"CH-VD": "Vaud",
	"CH-ZG": "Zug",
	"CH-ZH": "Zürich",
	"SY-HA": "Al Ḩasakah",
	"SY-LA": "Al Lādhiqīyah",
	"SY-QU": "Al Qunayţirah",
	"SY-RA": "Ar Raqqah",
	"SY-SU": "As Suwaydā'",
	"SY-DR": "Dar'ā",
	"SY-DY": "Dayr az Zawr",
	"SY-DI": "Dimashq",
	"SY-HL": "Ḩalab",
	"SY-HM": "Ḩamāh",
	"SY-HI": "Ḩimş",
	"SY-ID": "Idlib",
	"SY-RD": "Rīf Dimashq",
	"SY-TA": "Ţarţūs",
	"TW-CHA": "Changhua",
	"TW-CYI": "Chiayi",
	"TW-CYQ": "Chiayi",
	"TW-HSZ": "Hsinchu",
	"TW-HSQ": "Hsinchu",
	"TW-HUA": "Hualien",
	"TW-KHH": "Kaohsiung",
	"TW-KEE": "Keelung",
	"TW-KIN": "Kinmen",
	"TW-LIE": "Lienchiang",
	"TW-MIA": "Miaoli",
	"TW-NAN": "Nantou",
	"TW-NWT": "New Taipei",
	"TW-PEN": "Penghu",
	"TW-PIF": "Pingtung",
	"TW-TXG": "Taichung",
	"TW-TNN": "Tainan",
	"TW-TPE": "Taipei",
	"TW-TTT": "Taitung",
	"TW-TAO": "Taoyuan",
	"TW-ILA": "Yilan",
	"TW-YUN": "Yunlin",
	"TJ-DU": "Dushanbe",
	"TJ-KT": "Khatlon",
	"TJ-GB": "Kŭhistoni Badakhshon",
	"TJ-RA": "nohiyahoi tobei jumhurí",
	"TJ-SU": "Sughd",
	"TZ-01": "Arusha",
	"TZ-02": "Dar es Salaam",
	"TZ-03": "Dodoma",
	"TZ-27": "Geita",
	"TZ-04": "Iringa",
	"TZ-05": "Kagera",
	"TZ-06": "Kaskazini Pemba",
	"TZ-07": "Kaskazini Unguja",
	"TZ-28": "Katavi",
	"TZ-08": "Kigoma",
	"TZ-09": "Kilimanjaro",
	"TZ-10": "Kusini Pemba",
	"TZ-11": "Kusini Unguja",
	"TZ-12": "Lindi",
	"TZ-26": "Manyara",
	"TZ-13": "Mara",
	"TZ-14": "Mbeya",
	"TZ-15": "Mjini Magharibi",
	"TZ-16": "Morogoro",
	"TZ-17": "Mtwara",
	"TZ-18": "Mwanza",
	"TZ-29": "Njombe",
	"TZ-19": "Pwani",
	"TZ-20": "Rukwa",
	"TZ-21": "Ruvuma",
	"TZ-22": "Shinyanga",
	"TZ-30": "Simiyu",
	"TZ-23": "Singida",
	"TZ-31": "Songwe",
	"TZ-24": "Tabora",
	"TZ-25": "Tanga",
	"TH-37": "Amnat Charoen",
	"TH-15": "Ang Thong",
	"TH-38": "Bueng Kan",
	"TH-31": "Buri Ram",
	"TH-24": "Chachoengsao",
	"TH-18": "Chai Nat",
	"TH-36": "Chaiyaphum",
	"TH-22": "Chanthaburi",
	"TH-50": "Chiang Mai",
	"TH-57": "Chiang Rai",
	"TH-20": "Chon Buri",
	"TH-86": "Chumphon",
	"TH-46": "Kalasin",
	"TH-62": "Kamphaeng Phet",
	"TH-71": "Kanchanaburi",
	"TH-40": "Khon Kaen",
	"TH-81": "Krabi",
	"TH-10": "Bangkok",
	"TH-52": "Lampang",
	"TH-51": "Lamphun",
	"TH-42": "Loei",
	"TH-16": "Lop Buri",
	"TH-58": "Mae Hong Son",
	"TH-44": "Maha Sarakham",
	"TH-49": "Mukdahan",
	"TH-26": "Nakhon Nayok",
	"TH-73": "Nakhon Pathom",
	"TH-48": "Nakhon Phanom",
	"TH-30": "Nakhon Ratchasima",
	"TH-60": "Nakhon Sawan",
	"TH-80": "Nakhon Si Thammarat",
	"TH-55": "Nan",
	"TH-96": "Narathiwat",
	"TH-39": "Nong Bua Lam Phu",
	"TH-43": "Nong Khai",
	"TH-12": "Nonthaburi",
	"TH-13": "Pathum Thani",
	"TH-94": "Pattani",
	"TH-82": "Phangnga",
	"TH-93": "Phatthalung",
	"TH-S": "Phatthaya",
	"TH-56": "Phayao",
	"TH-67": "Phetchabun",
	"TH-76": "Phetchaburi",
	"TH-66": "Phichit",
	"TH-65": "Phitsanulok",
	"TH-14": "Phra Nakhon Si Ayutthaya",
	"TH-54": "Phrae",
	"TH-83": "Phuket",
	"TH-25": "Prachin Buri",
	"TH-77": "Prachuap Khiri Khan",
	"TH-85": "Ranong",
	"TH-70": "Ratchaburi",
	"TH-21": "Rayong",
	"TH-45": "Roi Et",
	"TH-27": "Sa Kaeo",
	"TH-47": "Sakon Nakhon",
	"TH-11": "Samut Prakan",
	"TH-74": "Samut Sakhon",
	"TH-75": "Samut Songkhram",
	"TH-19": "Saraburi",
	"TH-91": "Satun",
	"TH-33": "Si Sa Ket",
	"TH-17": "Sing Buri",
	"TH-90": "Songkhla",
	"TH-64": "Sukhothai",
	"TH-72": "Suphan Buri",
	"TH-84": "Surat Thani",
	"TH-32": "Surin",
	"TH-63": "Tak",
	"TH-92": "Trang",
	"TH-23": "Trat",
	"TH-34": "Ubon Ratchathani",
	"TH-41": "Udon Thani",
	"TH-61": "Uthai Thani",
	"TH-53": "Uttaradit",
	"TH-95": "Yala",
	"TH-35": "Yasothon",
	"TL-AL": "Aileu",
	"TL-AN": "Ainaro",
	"TL-BA": "Baucau",
	"TL-BO": "Bobonaro",
	"TL-CO": "Cova Lima",
	"TL-DI": "Díli",
	"TL-ER": "Ermera",
	"TL-LA": "Lautém",
	"TL-LI": "Liquiça",
	"TL-MT": "Manatuto",
	"TL-MF": "Manufahi",
	"TL-OE": "Oé-Cusse Ambeno",
	"TL-VI": "Viqueque",
	"TG-C": "Centrale",
	"TG-K": "Kara",
	"TG-M": "Maritime",
	"TG-P": "Plateaux",
	"TG-S": "Savanes",
	"TO-01": "'Eua",
	"TO-02": "Ha'apai",
	"TO-03": "Niuas",
	"TO-04": "Tongatapu",
	"TO-05": "Vava'u",
	"TT-ARI": "Arima",
	"TT-CHA": "Chaguanas",
	"TT-CTT": "Couva-Tabaquite-Talparo",
	"TT-DMN": "Diego Martin",
	"TT-MRC": "Mayaro-Rio Claro",
	"TT-PED": "Penal-Debe",
	"TT-POS": "Port of Spain",
	"TT-PRT": "Princes Town",
	"TT-PTF": "Point Fortin",
	"TT-SFO": "San Fernando",
	"TT-SGE": "Sangre Grande",
	"TT-SIP": "Siparia",
	"TT-SJL": "San Juan-Laventille",
	"TT-TOB": "Tobago",
	"TT-TUP": "Tunapuna-Piarco",
	"TN-31": "Béja",
	"TN-13": "Ben Arous",
	"TN-23": "Bizerte",
	"TN-81": "Gabès",
	"TN-71": "Gafsa",
	"TN-32": "Jendouba",
	"TN-41": "Kairouan",
	"TN-42": "Kasserine",
	"TN-73": "Kébili",
	"TN-12": "L'Ariana",
	"TN-14": "La Manouba",
	"TN-33": "Le Kef",
	"TN-53": "Mahdia",
	"TN-82": "Médenine",
	"TN-52": "Monastir",
	"TN-21": "Nabeul",
	"TN-61": "Sfax",
	"TN-43": "Sidi Bouzid",
	"TN-34": "Siliana",
	"TN-51": "Sousse",
	"TN-83": "Tataouine",
	"TN-72": "Tozeur",
	"TN-11": "Tunis",
	"TN-22": "Zaghouan",
	"TR-01": "Adana",
	"TR-02": "Adıyaman",
	"TR-03": "Afyonkarahisar",
	"TR-04": "Ağrı",
	"TR-68": "Aksaray",
	"TR-05": "Amasya",
	"TR-06": "Ankara",
	"TR-07": "Antalya",
	"TR-75": "Ardahan",
	"TR-08": "Artvin",
	"TR-09": "Aydın",
	"TR-10": "Balıkesir",
	"TR-74": "Bartın",
	"TR-72": "Batman",
	"TR-69": "Bayburt",
	"TR-11": "Bilecik",
	"TR-12": "Bingöl",
	"TR-13": "Bitlis",
	"TR-14": "Bolu",
	"TR-15": "Burdur",
	"TR-16": "Bursa",
	"TR-17": "Çanakkale",
	"TR-18": "Çankırı",
	"TR-19": "Çorum",
	"TR-20": "Denizli",
	"TR-21": "Diyarbakır",
	"TR-81": "Düzce",
	"TR-22": "Edirne",
	"TR-23": "Elazığ",
	"TR-24": "Erzincan",
	"TR-25": "Erzurum",
	"TR-26": "Eskişehir",
	"TR-27": "Gaziantep",
	"TR-28": "Giresun",
	"TR-29": "Gümüşhane",
	"TR-30": "Hakkâri",
	"TR-31": "Hatay",
	"TR-76": "Iğdır",
	"TR-32": "Isparta",
	"TR-34": "İstanbul",
	"TR-35": "İzmir",
	"TR-46": "Kahramanmaraş",
	"TR-78": "Karabük",
	"TR-70": "Karaman",
	"TR-36": "Kars",
	"TR-37": "Kastamonu",
	"TR-38": "Kayseri",
	"TR-71": "Kırıkkale",
	"TR-39": "Kırklareli",
	"TR-40": "Kırşehir",
	"TR-79": "Kilis",
	"TR-41": "Kocaeli",
	"TR-42": "Konya",
	"TR-43": "Kütahya",
	"TR-44": "Malatya",
	"TR-45": "Manisa",
	"TR-47": "Mardin",
	"TR-33": "Mersin",
	"TR-48": "Muğla",
	"TR-49": "Muş",
	"TR-50": "Nevşehir",
	"TR-51": "Niğde",
	"TR-52": "Ordu",
	"TR-80": "Osmaniye",
	"TR-53": "Rize",
	"TR-54": "Sakarya",
	"TR-55": "Samsun",
	"TR-56": "Siirt",
	"TR-57": "Sinop",
	"TR-58": "Sivas",
	"TR-63": "Şanlıurfa",
	"TR-73": "Şırnak",
	"TR-59": "Tekirdağ",
	"TR-60": "Tokat",
	"TR-61": "Trabzon",
	"TR-62": "Tunceli",
	"TR-64": "Uşak",
	"TR-65": "Van",
	"TR-77": "Yalova",
	"TR-66": "Yozgat",
	"TR-67": "Zonguldak",
	"TM-A": "Ahal",
	"TM-S": "Aşgabat",
	"TM-B": "Balkan",
	"TM-D": "Daşoguz",
	"TM-L": "Lebap",
	"TM-M": "Mary",
	"TV-FUN": "Funafuti",
	"TV-NMG": "Nanumaga",
	"TV-NMA": "Nanumea",
	"TV-NIT": "Niutao",
	"TV-NUI": "Nui",
	"TV-NKF": "Nukufetau",
	"TV-NKL": "Nukulaelae",
	"TV-VAI": "Vaitupu",
	"UG-C": "Central",
	"UG-E": "Eastern",
	"UG-N": "Northern",
	"UG-W": "Western",
	"UA-43": "Avtonomna Respublika Krym",
	"UA-71": "Cherkaska oblast",
	"UA-74": "Chernihivska oblast",
	"UA-77": "Chernivetska oblast",
	"UA-12": "Dnipropetrovska oblast",
	"UA-14": "Donetska oblast",
	"UA-26": "Ivano-Frankivska oblast",
	"UA-63": "Kharkivska oblast",
	"UA-65": "Khersonska oblast",
	"UA-68": "Khmelnytska oblast",
	"UA-35": "Kirovohradska oblast",
	"UA-30": "Kyiv",
	"UA-32": "Kyivska oblast",
	"UA-09": "Luhanska oblast",
	"UA-46": "Lvivska oblast",
	"UA-48": "Mykolaivska oblast",
	"UA-51": "Odeska oblast",
	"UA-53": "Poltavska oblast",
	"UA-56": "Rivnenska oblast",
	"UA-40": "Sevastopol",
	"UA-59": "Sumska oblast",
	"UA-61": "Ternopilska oblast",
	"UA-05": "Vinnytska oblast",
	"UA-07": "Volynska oblast",
	"UA-21": "Zakarpatska oblast",
	"UA-23": "Zaporizka oblast",
	"UA-18": "Zhytomyrska oblast",
	"AE-AJ": "‘Ajmān",
	"AE-AZ": "Abū Z̧aby",
	"AE-FU": "Al Fujayrah",
	"AE-SH": "Ash Shāriqah",
	"AE-DU": "Dubayy",
	"AE-RK": "Ra’s al Khaymah",
	"AE-UQ": "Umm al Qaywayn",
	"GB-ENG": "England",
	"GB-NIR": "Northern Ireland",
	"GB-SCT": "Scotland",
	"GB-WLS": "Wales",
	"US-AL": "Alabama",
	"US-AK": "Alaska",
	"US-AZ": "Arizona",
	"US-AR": "Arkansas",
	"US-CA": "California",
	"US-CO": "Colorado",
	"US-CT": "Connecticut",
	"US-DE": "Delaware",
	"US-FL": "Florida",
	"US-GA": "Georgia",
	"US-HI": "Hawaii",
	"US-ID": "Idaho",
	"US-IL": "Illinois",
	"US-IN": "Indiana",
	"US-IA": "Iowa",
	"US-KS": "Kansas",
	"US-KY": "Kentucky",
	"US-LA": "Louisiana",
	"US-ME": "Maine",
	"US-MD": "Maryland",
	"US-MA": "Massachusetts",
	"US-MI": "Michigan",
	"US-MN": "Minnesota",
	"US-MS": "Mississippi",
	"US-MO": "Missouri",
	"US-MT": "Montana",
	"US-NE": "Nebraska",
	"US-NV": "Nevada",
	"US-NH": "New Hampshire",
	"US-NJ": "New Jersey",
	"US-NM": "New Mexico",
	"US-NY": "New York",
	"US-NC": "North Carolina",
	"US-ND": "North Dakota",
	"US-OH": "Ohio",
	"US-OK": "Oklahoma",
	"US-OR": "Oregon",
	"US-PA": "Pennsylvania",
	"US-RI": "Rhode Island",
	"US-SC": "South Carolina",
	"US-SD": "South Dakota",
	"US-TN": "Tennessee",
	"US-TX": "Texas",
	"US-UT": "Utah",
	"US-VT": "Vermont",
	"US-VA": "Virginia",
	"US-WA": "Washington",
	"US-WV": "West Virginia",
	"US-WI": "Wisconsin",
	"US-WY": "Wyoming",
	"US-DC": "District of Columbia",
	"US-AS": "American Samoa",
	"US-GU": "Guam",
	"US-MP": "Northern Mariana Islands",
	"US-PR": "Puerto Rico",
	"US-UM": "United States Minor Outlying Islands",
	"US-VI": "Virgin Islands",
	"UM-81": "Baker Island",
	"UM-84": "Howland Island",
	"UM-86": "Jarvis Island",
	"UM-67": "Johnston Atoll",
	"UM-89": "Kingman Reef",
	"UM-71": "Midway Islands",
	"UM-76": "Navassa Island",
	"UM-95": "Palmyra Atoll",
	"UM-79": "Wake Island",
	"UY-AR": "Artigas",
	"UY-CA": "Canelones",
	"UY-CL": "Cerro Largo",
	"UY-CO": "Colonia",
	"UY-DU": "Durazno",
	"UY-FS": "Flores",
	"UY-FD": "Florida",
	"UY-LA": "Lavalleja",
	"UY-MA": "Maldonado",
	"UY-MO": "Montevideo",
	"UY-PA": "Paysandú",
	"UY-RN": "Río Negro",
	"UY-RV": "Rivera",
	"UY-RO": "Rocha",
	"UY-SA": "Salto",
	"UY-SJ": "San José",
	"UY-SO": "Soriano",
	"UY-TA": "Tacuarembó",
	"UY-TT": "Treinta y Tres",
	"UZ-AN": "Andijon",
	"UZ-BU": "Buxoro",
	"UZ-FA": "Farg‘ona",
	"UZ-JI": "Jizzax",
	"UZ-NG": "Namangan",
	"UZ-NW": "Navoiy",
	"UZ-QA": "Qashqadaryo",
	"UZ-QR": "Qoraqalpog‘iston Respublikasi",
	"UZ-SA": "Samarqand",
	"UZ-SI": "Sirdaryo",
	"UZ-SU": "Surxondaryo",
	"UZ-TK": "Toshkent",
	"UZ-TO": "Toshkent",
	"UZ-XO": "Xorazm",
	"VU-MAP": "Malampa",
	"VU-PAM": "Pénama",
	"VU-SAM": "Sanma",
	"VU-SEE": "Shéfa",
	"VU-TAE": "Taféa",
	"VU-TOB": "Torba",
	"VE-Z": "Amazonas",
	"VE-B": "Anzoátegui",
	"VE-C": "Apure",
	"VE-D": "Aragua",
	"VE-E": "Barinas",
	"VE-F": "Bolívar",
	"VE-G": "Carabobo",
	"VE-H": "Cojedes",
	"VE-Y": "Delta Amacuro",
	"VE-W": "Dependencias Federales",
	"VE-A": "Distrito Capital",
	"VE-I": "Falcón",
	"VE-J": "Guárico",
	"VE-X": "La Guaira",
	"VE-K": "Lara",
	"VE-L": "Mérida",
	"VE-M": "Miranda",
	"VE-N": "Monagas",
	"VE-O": "Nueva Esparta",
	"VE-P": "Portuguesa",
	"VE-R": "Sucre",
	"VE-S": "Táchira",
	"VE-T": "Trujillo",
	"VE-U": "Yaracuy",
	"VE-V": "Zulia",
	"VN-44": "An Giang",
	"VN-43": "Bà Rịa - Vũng Tàu",
	"VN-54": "Bắc Giang",
	"VN-53": "Bắc Kạn",
	"VN-55": "Bạc Liêu",
	"VN-56": "Bắc Ninh",
	"VN-50": "Bến Tre",
	"VN-31": "Bình Định",
	"VN-57": "Bình Dương",
	"VN-58": "Bình Phước",
	"VN-40": "Bình Thuận",
	"VN-59": "Cà Mau",
	"VN-CT": "Cần Thơ",
	"VN-04": "Cao Bằng",
	"VN-DN": "Đà Nẵng",
	"VN-33": "Đắk Lắk",
	"VN-72": "Đắk Nông",
	"VN-71": "Điện Biên",
	"VN-39": "Đồng Nai",
	"VN-45": "Đồng Tháp",
	"VN-30": "Gia Lai",
	"VN-03": "Hà Giang",
	"VN-63": "Hà Nam",
	"VN-HN": "Hà Nội",
	"VN-23": "Hà Tĩnh",
	"VN-61": "Hải Dương",
	"VN-HP": "Hải Phòng",
	"VN-73": "Hậu Giang",
	"VN-SG": "Hồ Chí Minh",
	"VN-14": "Hòa Bình",
	"VN-66": "Hưng Yên",
	"VN-34": "Khánh Hòa",
	"VN-47": "Kiến Giang",
	"VN-28": "Kon Tum",
	"VN-01": "Lai Châu",
	"VN-35": "Lâm Đồng",
	"VN-09": "Lạng Sơn",
	"VN-02": "Lào Cai",
	"VN-41": "Long An",
	"VN-67": "Nam Định",
	"VN-22": "Nghệ An",
	"VN-18": "Ninh Bình",
	"VN-36": "Ninh Thuận",
	"VN-68": "Phú Thọ",
	"VN-32": "Phú Yên",
	"VN-24": "Quảng Bình",
	"VN-27": "Quảng Nam",
	"VN-29": "Quảng Ngãi",
	"VN-13": "Quảng Ninh",
	"VN-25": "Quảng Trị",
	"VN-52": "Sóc Trăng",
	"VN-05": "Sơn La",
	"VN-37": "Tây Ninh",
	"VN-20": "Thái Bình",
	"VN-69": "Thái Nguyên",
	"VN-21": "Thanh Hóa",
	"VN-26": "Thừa Thiên-Huế",
	"VN-46": "Tiền Giang",
	"VN-51": "Trà Vinh",
	"VN-07": "Tuyên Quang",
	"VN-49": "Vĩnh Long",
	"VN-70": "Vĩnh Phúc",
	"VN-06": "Yên Bái",
	"WF-AL": "Alo",
	"WF-SG": "Sigave",
	"WF-UV": "Uvea",
	"YE-AD": "‘Adan",
	"YE-AM": "‘Amrān",
	"YE-AB": "Abyan",
	"YE-DA": "Aḑ Ḑāli‘",
	"YE-BA": "Al Bayḑā’",
	"YE-HU": "Al Ḩudaydah",
	"YE-JA": "Al Jawf",
	"YE-MR": "Al Mahrah",
	"YE-MW": "Al Maḩwīt",
	"YE-SA": "Amānat al ‘Āşimah",
	"YE-SU": "Arkhabīl Suquţrá",
	"YE-DH": "Dhamār",
	"YE-HD": "Ḩaḑramawt",
	"YE-HJ": "Ḩajjah",
	"YE-IB": "Ibb",
	"YE-LA": "Laḩij",
	"YE-MA": "Ma’rib",
	"YE-RA": "Raymah",
	"YE-SD": "Şāʻdah",
	"YE-SN": "Şanʻā’",
	"YE-SH": "Shabwah",
	"YE-TA": "Tāʻizz",
	"ZM-02": "Central",
	"ZM-08": "Copperbelt",
	"ZM-03": "Eastern",
	"ZM-04": "Luapula",
	"ZM-09": "Lusaka",
	"ZM-10": "Muchinga",
	"ZM-06": "North-Western",
	"ZM-05": "Northern",
	"ZM-07": "Southern",
	"ZM-01": "Western",
	"ZW-BU": "Bulawayo",
	"ZW-HA": "Harare",
	"ZW-MA": "Manicaland",
	"ZW-MC": "Mashonaland Central",
	"ZW-ME": "Mashonaland East",
	"ZW-MW": "Mashonaland West",
	"ZW-MV": "Masvingo",
	"ZW-MN": "Matabeleland North",
	"ZW-MS": "Matabeleland South",
	"ZW-MI": "Midlands",
	"BQ-BO": "Bonaire",
	"BQ-SA": "Saba",
	"BQ-SE": "Sint Eustatius",
	"ME-01": "Andrijevica",
	"ME-02": "Bar",
	"ME-03": "Berane",
	"ME-04": "Bijelo Polje",
	"ME-05": "Budva",
	"ME-06": "Cetinje",
	"ME-07": "Danilovgrad",
	"ME-22": "Gusinje",
	"ME-08": "Herceg-Novi",
	"ME-09": "Kolašin",
	"ME-10": "Kotor",
	"ME-11": "Mojkovac",
	"ME-12": "Nikšić",
	"ME-23": "Petnjica",
	"ME-13": "Plav",
	"ME-14": "Pljevlja",
	"ME-15": "Plužine",
	"ME-16": "Podgorica",
	"ME-17": "Rožaje",
	"ME-18": "Šavnik",
	"ME-19": "Tivat",
	"ME-24": "Tuzi",
	"ME-20": "Ulcinj",
	"ME-21": "Žabljak",
	"ME-25": "Zeta",
	"RS-KM": "Kosovo-Metohija[1]",
	"RS-VO": "Vojvodina",
	"SS-EC": "Central Equatoria",
	"SS-EE": "Eastern Equatoria",
	"SS-JG": "Jonglei",
	"SS-LK": "Lakes",
	"SS-BN": "Northern Bahr el Ghazal",
	"SS-UY": "Unity",
	"SS-NU": "Upper Nile",
	"SS-WR": "Warrap",
	"SS-BW": "Western Bahr el Ghazal",
	"SS-EW": "Western Equatoria",
};

export const CONTINENTS = {
	AF: "Africa",
	AN: "Antarctica",
	AS: "Asia",
	EU: "Europe",
	NA: "North America",
	OC: "Oceania",
	SA: "South America",
};

export const CONTINENT_CODES = Object.keys(CONTINENTS);

export const COUNTRIES_TO_CONTINENTS = {
	AF: "AS", // Afghanistan - Asia
	AL: "EU", // Albania - Europe
	DZ: "AF", // Algeria - Africa
	AS: "OC", // American Samoa - Oceania
	AD: "EU", // Andorra - Europe
	AO: "AF", // Angola - Africa
	AI: "NA", // Anguilla - North America
	AQ: "AN", // Antarctica - Antarctica
	AG: "NA", // Antigua and Barbuda - North America
	AR: "SA", // Argentina - South America
	AM: "AS", // Armenia - Asia
	AW: "NA", // Aruba - North America
	AU: "OC", // Australia - Oceania
	AT: "EU", // Austria - Europe
	AZ: "AS", // Azerbaijan - Asia
	BS: "NA", // Bahamas - North America
	BH: "AS", // Bahrain - Asia
	BD: "AS", // Bangladesh - Asia
	BB: "NA", // Barbados - North America
	BY: "EU", // Belarus - Europe
	BE: "EU", // Belgium - Europe
	BZ: "NA", // Belize - North America
	BJ: "AF", // Benin - Africa
	BM: "NA", // Bermuda - North America
	BT: "AS", // Bhutan - Asia
	BO: "SA", // Bolivia - South America
	BA: "EU", // Bosnia and Herzegovina - Europe
	BW: "AF", // Botswana - Africa
	BV: "AN", // Bouvet Island - Antarctica
	BR: "SA", // Brazil - South America
	IO: "AS", // British Indian Ocean Territory - Asia
	BN: "AS", // Brunei Darussalam - Asia
	BG: "EU", // Bulgaria - Europe
	BF: "AF", // Burkina Faso - Africa
	BI: "AF", // Burundi - Africa
	KH: "AS", // Cambodia - Asia
	CM: "AF", // Cameroon - Africa
	CA: "NA", // Canada - North America
	CV: "AF", // Cape Verde - Africa
	KY: "NA", // Cayman Islands - North America
	CF: "AF", // Central African Republic - Africa
	TD: "AF", // Chad - Africa
	CL: "SA", // Chile - South America
	CN: "AS", // China - Asia
	CX: "AS", // Christmas Island - Asia
	CC: "AS", // Cocos (Keeling) Islands - Asia
	CO: "SA", // Colombia - South America
	KM: "AF", // Comoros - Africa
	CG: "AF", // Congo (Republic) - Africa
	CD: "AF", // Congo (Democratic Republic) - Africa
	CK: "OC", // Cook Islands - Oceania
	CR: "NA", // Costa Rica - North America
	CI: "AF", // Ivory Coast - Africa
	HR: "EU", // Croatia - Europe
	CU: "NA", // Cuba - North America
	CY: "AS", // Cyprus - Asia
	CZ: "EU", // Czech Republic - Europe
	DK: "EU", // Denmark - Europe
	DJ: "AF", // Djibouti - Africa
	DM: "NA", // Dominica - North America
	DO: "NA", // Dominican Republic - North America
	EC: "SA", // Ecuador - South America
	EG: "AF", // Egypt - Africa
	SV: "NA", // El Salvador - North America
	GQ: "AF", // Equatorial Guinea - Africa
	ER: "AF", // Eritrea - Africa
	EE: "EU", // Estonia - Europe
	ET: "AF", // Ethiopia - Africa
	FK: "SA", // Falkland Islands - South America
	FO: "EU", // Faroe Islands - Europe
	FJ: "OC", // Fiji - Oceania
	FI: "EU", // Finland - Europe
	FR: "EU", // France - Europe
	GF: "SA", // French Guiana - South America
	PF: "OC", // French Polynesia - Oceania
	TF: "AN", // French Southern Territories - Antarctica
	GA: "AF", // Gabon - Africa
	GM: "AF", // Gambia - Africa
	GE: "AS", // Georgia - Asia
	DE: "EU", // Germany - Europe
	GH: "AF", // Ghana - Africa
	GI: "EU", // Gibraltar - Europe
	GR: "EU", // Greece - Europe
	GL: "NA", // Greenland - North America
	GD: "NA", // Grenada - North America
	GP: "NA", // Guadeloupe - North America
	GU: "OC", // Guam - Oceania
	GT: "NA", // Guatemala - North America
	GN: "AF", // Guinea - Africa
	GW: "AF", // Guinea-Bissau - Africa
	GY: "SA", // Guyana - South America
	HT: "NA", // Haiti - North America
	HM: "AN", // Heard Island and McDonald Islands - Antarctica
	VA: "EU", // Vatican City - Europe
	HN: "NA", // Honduras - North America
	HK: "AS", // Hong Kong - Asia
	HU: "EU", // Hungary - Europe
	IS: "EU", // Iceland - Europe
	IN: "AS", // India - Asia
	ID: "AS", // Indonesia - Asia
	IR: "AS", // Iran - Asia
	IQ: "AS", // Iraq - Asia
	IE: "EU", // Ireland - Europe
	IL: "AS", // Israel - Asia
	IT: "EU", // Italy - Europe
	JM: "NA", // Jamaica - North America
	JP: "AS", // Japan - Asia
	JO: "AS", // Jordan - Asia
	KZ: "AS", // Kazakhstan - Asia
	KE: "AF", // Kenya - Africa
	KI: "OC", // Kiribati - Oceania
	KP: "AS", // North Korea - Asia
	KR: "AS", // South Korea - Asia
	KW: "AS", // Kuwait - Asia
	KG: "AS", // Kyrgyzstan - Asia
	LA: "AS", // Laos - Asia
	LV: "EU", // Latvia - Europe
	LB: "AS", // Lebanon - Asia
	LS: "AF", // Lesotho - Africa
	LR: "AF", // Liberia - Africa
	LY: "AF", // Libya - Africa
	LI: "EU", // Liechtenstein - Europe
	LT: "EU", // Lithuania - Europe
	LU: "EU", // Luxembourg - Europe
	MO: "AS", // Macao - Asia
	MG: "AF", // Madagascar - Africa
	MW: "AF", // Malawi - Africa
	MY: "AS", // Malaysia - Asia
	MV: "AS", // Maldives - Asia
	ML: "AF", // Mali - Africa
	MT: "EU", // Malta - Europe
	MH: "OC", // Marshall Islands - Oceania
	MQ: "NA", // Martinique - North America
	MR: "AF", // Mauritania - Africa
	MU: "AF", // Mauritius - Africa
	YT: "AF", // Mayotte - Africa
	MX: "NA", // Mexico - North America
	FM: "OC", // Micronesia - Oceania
	MD: "EU", // Moldova - Europe
	MC: "EU", // Monaco - Europe
	MN: "AS", // Mongolia - Asia
	MS: "NA", // Montserrat - North America
	MA: "AF", // Morocco - Africa
	MZ: "AF", // Mozambique - Africa
	MM: "AS", // Myanmar - Asia
	NA: "AF", // Namibia - Africa
	NR: "OC", // Nauru - Oceania
	NP: "AS", // Nepal - Asia
	NL: "EU", // Netherlands - Europe
	NC: "OC", // New Caledonia - Oceania
	NZ: "OC", // New Zealand - Oceania
	NI: "NA", // Nicaragua - North America
	NE: "AF", // Niger - Africa
	NG: "AF", // Nigeria - Africa
	NU: "OC", // Niue - Oceania
	NF: "OC", // Norfolk Island - Oceania
	MK: "EU", // Macedonia - Europe
	MP: "OC", // Northern Mariana Islands - Oceania
	NO: "EU", // Norway - Europe
	OM: "AS", // Oman - Asia
	PK: "AS", // Pakistan - Asia
	PW: "OC", // Palau - Oceania
	PS: "AS", // Palestine - Asia
	PA: "NA", // Panama - North America
	PG: "OC", // Papua New Guinea - Oceania
	PY: "SA", // Paraguay - South America
	PE: "SA", // Peru - South America
	PH: "AS", // Philippines - Asia
	PN: "OC", // Pitcairn - Oceania
	PL: "EU", // Poland - Europe
	PT: "EU", // Portugal - Europe
	PR: "NA", // Puerto Rico - North America
	QA: "AS", // Qatar - Asia
	RE: "AF", // Reunion - Africa
	RO: "EU", // Romania - Europe
	RU: "EU", // Russia - Europe
	RW: "AF", // Rwanda - Africa
	SH: "AF", // Saint Helena - Africa
	KN: "NA", // Saint Kitts and Nevis - North America
	LC: "NA", // Saint Lucia - North America
	PM: "NA", // Saint Pierre and Miquelon - North America
	VC: "NA", // Saint Vincent and the Grenadines - North America
	WS: "OC", // Samoa - Oceania
	SM: "EU", // San Marino - Europe
	ST: "AF", // Sao Tome and Principe - Africa
	SA: "AS", // Saudi Arabia - Asia
	SN: "AF", // Senegal - Africa
	SC: "AF", // Seychelles - Africa
	SL: "AF", // Sierra Leone - Africa
	SG: "AS", // Singapore - Asia
	SK: "EU", // Slovakia - Europe
	SI: "EU", // Slovenia - Europe
	SB: "OC", // Solomon Islands - Oceania
	SO: "AF", // Somalia - Africa
	ZA: "AF", // South Africa - Africa
	GS: "AN", // South Georgia and the South Sandwich Islands - Antarctica
	ES: "EU", // Spain - Europe
	LK: "AS", // Sri Lanka - Asia
	SD: "AF", // Sudan - Africa
	SR: "SA", // Suriname - South America
	SJ: "EU", // Svalbard and Jan Mayen - Europe
	SZ: "AF", // Eswatini - Africa
	SE: "EU", // Sweden - Europe
	CH: "EU", // Switzerland - Europe
	SY: "AS", // Syrian Arab Republic - Asia
	TW: "AS", // Taiwan - Asia
	TJ: "AS", // Tajikistan - Asia
	TZ: "AF", // Tanzania - Africa
	TH: "AS", // Thailand - Asia
	TL: "AS", // Timor-Leste - Asia
	TG: "AF", // Togo - Africa
	TK: "OC", // Tokelau - Oceania
	TO: "OC", // Tonga - Oceania
	TT: "NA", // Trinidad and Tobago - North America
	TN: "AF", // Tunisia - Africa
	TR: "AS", // Turkey - Asia
	TM: "AS", // Turkmenistan - Asia
	TC: "NA", // Turks and Caicos Islands - North America
	TV: "OC", // Tuvalu - Oceania
	UG: "AF", // Uganda - Africa
	UA: "EU", // Ukraine - Europe
	AE: "AS", // United Arab Emirates - Asia
	GB: "EU", // United Kingdom - Europe
	US: "NA", // United States - North America
	UM: "OC", // United States Minor Outlying Islands - Oceania
	UY: "SA", // Uruguay - South America
	UZ: "AS", // Uzbekistan - Asia
	VU: "OC", // Vanuatu - Oceania
	VE: "SA", // Venezuela - South America
	VN: "AS", // Vietnam - Asia
	VG: "NA", // Virgin Islands, British - North America
	VI: "NA", // Virgin Islands, U.S. - North America
	WF: "OC", // Wallis and Futuna - Oceania
	EH: "AF", // Western Sahara - Africa
	YE: "AS", // Yemen - Asia
	ZM: "AF", // Zambia - Africa
	ZW: "AF", // Zimbabwe - Africa
	AX: "EU", // Åland Islands - Europe
	BQ: "NA", // Bonaire, Sint Eustatius and Saba - North America
	CW: "NA", // Curaçao - North America
	GG: "EU", // Guernsey - Europe
	IM: "EU", // Isle of Man - Europe
	JE: "EU", // Jersey - Europe
	ME: "EU", // Montenegro - Europe
	BL: "NA", // Saint Barthélemy - North America
	MF: "NA", // Saint Martin (French part) - North America
	RS: "EU", // Serbia - Europe
	SX: "NA", // Sint Maarten (Dutch part) - North America
	SS: "AF", // South Sudan - Africa
	XK: "EU", // Kosovo - Europe
};

export const COUNTRIES = {
	AF: "Afghanistan",
	AL: "Albania",
	DZ: "Algeria",
	AS: "American Samoa",
	AD: "Andorra",
	AO: "Angola",
	AI: "Anguilla",
	AQ: "Antarctica",
	AG: "Antigua and Barbuda",
	AR: "Argentina",
	AM: "Armenia",
	AW: "Aruba",
	AU: "Australia",
	AT: "Austria",
	AZ: "Azerbaijan",
	BS: "Bahamas",
	BH: "Bahrain",
	BD: "Bangladesh",
	BB: "Barbados",
	BY: "Belarus",
	BE: "Belgium",
	BZ: "Belize",
	BJ: "Benin",
	BM: "Bermuda",
	BT: "Bhutan",
	BO: "Bolivia",
	BA: "Bosnia and Herzegovina",
	BW: "Botswana",
	BV: "Bouvet Island",
	BR: "Brazil",
	IO: "British Indian Ocean Territory",
	BN: "Brunei Darussalam",
	BG: "Bulgaria",
	BF: "Burkina Faso",
	BI: "Burundi",
	KH: "Cambodia",
	CM: "Cameroon",
	CA: "Canada",
	CV: "Cape Verde",
	KY: "Cayman Islands",
	CF: "Central African Republic",
	TD: "Chad",
	CL: "Chile",
	CN: "China",
	CX: "Christmas Island",
	CC: "Cocos (Keeling) Islands",
	CO: "Colombia",
	KM: "Comoros",
	CG: "Congo (Republic)",
	CD: "Congo (Democratic Republic)",
	CK: "Cook Islands",
	CR: "Costa Rica",
	CI: "Ivory Coast",
	HR: "Croatia",
	CU: "Cuba",
	CY: "Cyprus",
	CZ: "Czech Republic",
	DK: "Denmark",
	DJ: "Djibouti",
	DM: "Dominica",
	DO: "Dominican Republic",
	EC: "Ecuador",
	EG: "Egypt",
	SV: "El Salvador",
	GQ: "Equatorial Guinea",
	ER: "Eritrea",
	EE: "Estonia",
	ET: "Ethiopia",
	FK: "Falkland Islands",
	FO: "Faroe Islands",
	FJ: "Fiji",
	FI: "Finland",
	FR: "France",
	GF: "French Guiana",
	PF: "French Polynesia",
	TF: "French Southern Territories",
	GA: "Gabon",
	GM: "Gambia",
	GE: "Georgia",
	DE: "Germany",
	GH: "Ghana",
	GI: "Gibraltar",
	GR: "Greece",
	GL: "Greenland",
	GD: "Grenada",
	GP: "Guadeloupe",
	GU: "Guam",
	GT: "Guatemala",
	GN: "Guinea",
	GW: "Guinea-Bissau",
	GY: "Guyana",
	HT: "Haiti",
	HM: "Heard Island and McDonald Islands",
	VA: "Vatican City",
	HN: "Honduras",
	HK: "Hong Kong",
	HU: "Hungary",
	IS: "Iceland",
	IN: "India",
	ID: "Indonesia",
	IR: "Iran",
	IQ: "Iraq",
	IE: "Ireland",
	IL: "Israel",
	IT: "Italy",
	JM: "Jamaica",
	JP: "Japan",
	JO: "Jordan",
	KZ: "Kazakhstan",
	KE: "Kenya",
	KI: "Kiribati",
	KP: "North Korea",
	KR: "South Korea",
	KW: "Kuwait",
	KG: "Kyrgyzstan",
	LA: "Laos",
	LV: "Latvia",
	LB: "Lebanon",
	LS: "Lesotho",
	LR: "Liberia",
	LY: "Libya",
	LI: "Liechtenstein",
	LT: "Lithuania",
	LU: "Luxembourg",
	MO: "Macao",
	MG: "Madagascar",
	MW: "Malawi",
	MY: "Malaysia",
	MV: "Maldives",
	ML: "Mali",
	MT: "Malta",
	MH: "Marshall Islands",
	MQ: "Martinique",
	MR: "Mauritania",
	MU: "Mauritius",
	YT: "Mayotte",
	MX: "Mexico",
	FM: "Micronesia",
	MD: "Moldova",
	MC: "Monaco",
	MN: "Mongolia",
	MS: "Montserrat",
	MA: "Morocco",
	MZ: "Mozambique",
	MM: "Myanmar",
	NA: "Namibia",
	NR: "Nauru",
	NP: "Nepal",
	NL: "Netherlands",
	NC: "New Caledonia",
	NZ: "New Zealand",
	NI: "Nicaragua",
	NE: "Niger",
	NG: "Nigeria",
	NU: "Niue",
	NF: "Norfolk Island",
	MK: "Macedonia",
	MP: "Northern Mariana Islands",
	NO: "Norway",
	OM: "Oman",
	PK: "Pakistan",
	PW: "Palau",
	PS: "Palestine",
	PA: "Panama",
	PG: "Papua New Guinea",
	PY: "Paraguay",
	PE: "Peru",
	PH: "Philippines",
	PN: "Pitcairn",
	PL: "Poland",
	PT: "Portugal",
	PR: "Puerto Rico",
	QA: "Qatar",
	RE: "Reunion",
	RO: "Romania",
	RU: "Russia",
	RW: "Rwanda",
	SH: "Saint Helena",
	KN: "Saint Kitts and Nevis",
	LC: "Saint Lucia",
	PM: "Saint Pierre and Miquelon",
	VC: "Saint Vincent and the Grenadines",
	WS: "Samoa",
	SM: "San Marino",
	ST: "Sao Tome and Principe",
	SA: "Saudi Arabia",
	SN: "Senegal",
	SC: "Seychelles",
	SL: "Sierra Leone",
	SG: "Singapore",
	SK: "Slovakia",
	SI: "Slovenia",
	SB: "Solomon Islands",
	SO: "Somalia",
	ZA: "South Africa",
	GS: "South Georgia and the South Sandwich Islands",
	ES: "Spain",
	LK: "Sri Lanka",
	SD: "Sudan",
	SR: "Suriname",
	SJ: "Svalbard and Jan Mayen",
	SZ: "Eswatini",
	SE: "Sweden",
	CH: "Switzerland",
	SY: "Syrian Arab Republic",
	TW: "Taiwan",
	TJ: "Tajikistan",
	TZ: "Tanzania",
	TH: "Thailand",
	TL: "Timor-Leste",
	TG: "Togo",
	TK: "Tokelau",
	TO: "Tonga",
	TT: "Trinidad and Tobago",
	TN: "Tunisia",
	TR: "Turkey",
	TM: "Turkmenistan",
	TC: "Turks and Caicos Islands",
	TV: "Tuvalu",
	UG: "Uganda",
	UA: "Ukraine",
	AE: "United Arab Emirates",
	GB: "United Kingdom",
	US: "United States",
	UM: "United States Minor Outlying Islands",
	UY: "Uruguay",
	UZ: "Uzbekistan",
	VU: "Vanuatu",
	VE: "Venezuela",
	VN: "Vietnam",
	VG: "Virgin Islands, British",
	VI: "Virgin Islands, U.S.",
	WF: "Wallis and Futuna",
	EH: "Western Sahara",
	YE: "Yemen",
	ZM: "Zambia",
	ZW: "Zimbabwe",
	AX: "Åland Islands",
	BQ: "Bonaire, Sint Eustatius and Saba",
	CW: "Curaçao",
	GG: "Guernsey",
	IM: "Isle of Man",
	JE: "Jersey",
	ME: "Montenegro",
	BL: "Saint Barthélemy",
	MF: "Saint Martin (French part)",
	RS: "Serbia",
	SX: "Sint Maarten (Dutch part)",
	SS: "South Sudan",
	XK: "Kosovo",
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);

export const EU_COUNTRY_CODES = [
	"AT",
	"BE",
	"BG",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GB",
	"GR",
	"HR",
	"HU",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SE",
	"SI",
	"SK",
];

function usageAndExit(message, code = 1) {
	if (message) console.error(message);
	console.error(
		[
			"Usage: node scripts/analytics/migrate-dub-to-tinybird.js [options]",
			"",
			"Options:",
			"  --dry-run                 Dry run (no writes). Default: true",
			"  --apply                   Perform writes to Tinybird (sets dry-run=false)",
			"  --domain <domain>         Dub link domain. Default: cap.link",
			"  --interval <ival>         Dub interval (24h,7d,30d,90d,1y,all). Default: 30d",
			"  --start <iso>             Start ISO datetime (overrides interval)",
			"  --end <iso>               End ISO datetime (overrides interval)",
			"  --timezone <tz>           IANA timezone for timeseries. Default: UTC",
			"  --video <id>              Video ID to migrate (repeatable, optional - defaults to all links from domain)",
			"  --videos-file <path>      File with newline-separated video IDs (optional)",
			"  --org <orgId>             Default tenant orgId for videos (optional, uses empty string if not provided)",
			'  --map <path>              JSON mapping file: { "<videoId>": "<orgId>" } (optional)',
			"  --max-cities <n>          Limit number of cities per video. Default: 25",
			"  --limit <n>               Limit number of videos to process (useful for testing). Default: unlimited",
			"  --video-concurrency <n>   Number of videos to process in parallel. Default: 4",
			"  --dub-concurrency <n>     Max concurrent Dub API requests per process. Default: 8",
			"  --ingest-chunk <n>        Tinybird ingest chunk size. Default: 5000",
			"  --ingest-concurrency <n>  Max concurrent Tinybird ingest requests. Default: 4",
			"  --ingest-rate-limit <n>  Tinybird requests per second. Default: 10",
			"",
			"By default, fetches all links from the specified domain and migrates analytics for each.",
			"The link key (slug) is used as the videoId.",
			"",
			"Environment:",
			"  DUB_API_KEY (required), TINYBIRD_TOKEN (required for --apply), TINYBIRD_HOST (optional)",
		].join("\n"),
	);
	process.exit(code);
}

function parseArgs(argv) {
	const args = {
		dryRun: true,
		domain: DEFAULT_DOMAIN,
		interval: DEFAULT_INTERVAL,
		start: null,
		end: null,
		timezone: DEFAULT_TIMEZONE,
		videoIds: [],
		orgs: [],
		mapPath: null,
		maxCities: MAX_CITY_COUNT,
		limit: null,
		apply: false,
		videoConcurrency: DEFAULT_VIDEO_CONCURRENCY,
		apiConcurrency: DEFAULT_API_CONCURRENCY,
		ingestChunk: INGEST_CHUNK_SIZE,
		ingestConcurrency: DEFAULT_INGEST_CONCURRENCY,
		ingestRateLimit: DEFAULT_INGEST_RATE_LIMIT,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--apply") {
			args.apply = true;
			args.dryRun = false;
		} else if (a === "--domain") args.domain = argv[++i];
		else if (a === "--interval") args.interval = argv[++i];
		else if (a === "--start") args.start = argv[++i];
		else if (a === "--end") args.end = argv[++i];
		else if (a === "--timezone") args.timezone = argv[++i];
		else if (a === "--video") args.videoIds.push(argv[++i]);
		else if (a === "--videos-file") {
			const file = argv[++i];
			const raw = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
			const ids = raw
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			args.videoIds.push(...ids);
		} else if (a === "--org") args.orgs.push(argv[++i]);
		else if (a === "--map") args.mapPath = argv[++i];
		else if (a === "--max-cities")
			args.maxCities = Number(argv[++i] || MAX_CITY_COUNT) || MAX_CITY_COUNT;
		else if (a === "--limit") {
			const limitVal = argv[++i];
			if (limitVal) {
				const num = Number(limitVal);
				args.limit = num > 0 ? num : null;
			}
		} else if (a === "--video-concurrency") {
			const n = Number(argv[++i]);
			if (!Number.isNaN(n) && n > 0) args.videoConcurrency = n;
		} else if (a === "--dub-concurrency") {
			const n = Number(argv[++i]);
			if (!Number.isNaN(n) && n > 0) args.apiConcurrency = n;
		} else if (a === "--ingest-chunk") {
			const n = Number(argv[++i]);
			if (!Number.isNaN(n) && n > 0) args.ingestChunk = n;
		} else if (a === "--ingest-concurrency") {
			const n = Number(argv[++i]);
			if (!Number.isNaN(n) && n > 0) args.ingestConcurrency = n;
		} else if (a === "--ingest-rate-limit") {
			const n = Number(argv[++i]);
			if (!Number.isNaN(n) && n > 0) args.ingestRateLimit = n;
		} else usageAndExit(`Unknown argument: ${a}`);
	}
	return args;
}

function loadVideoToOrgMap(args, videoIds) {
	const map = new Map();
	if (args.mapPath) {
		const p = path.resolve(process.cwd(), args.mapPath);
		const json = JSON.parse(fs.readFileSync(p, "utf8"));
		for (const [k, v] of Object.entries(json)) map.set(String(k), String(v));
	}
	if (args.orgs.length) {
		const defaultOrg = args.orgs[0] || "";
		if (args.orgs.length === 1) {
			for (const vid of videoIds) {
				if (!map.has(vid)) map.set(vid, defaultOrg);
			}
		} else if (args.orgs.length === videoIds.length) {
			for (let i = 0; i < videoIds.length; i++) {
				if (!map.has(videoIds[i])) map.set(videoIds[i], args.orgs[i] || "");
			}
		} else {
			usageAndExit(
				"Provide either one --org for all videos or one --org per video",
			);
		}
	}
	return map;
}

function requireEnv(name) {
	const v = process.env[name];
	if (!v || !v.trim()) usageAndExit(`Missing required env: ${name}`);
	return v.trim();
}

function qs(params) {
	const sp = new URLSearchParams();
	Object.entries(params).forEach(([k, v]) => {
		if (v === undefined || v === null || v === "") return;
		sp.set(k, String(v));
	});
	return sp.toString();
}

function createLimiter(max) {
	let active = 0;
	const queue = [];
	const runNext = () => {
		if (active >= max) return;
		const item = queue.shift();
		if (!item) return;
		active++;
		Promise.resolve()
			.then(item.fn)
			.then((v) => {
				active--;
				item.resolve(v);
				runNext();
			})
			.catch((e) => {
				active--;
				item.reject(e);
				runNext();
			});
	};
	return function limit(fn) {
		return new Promise((resolve, reject) => {
			queue.push({ fn, resolve, reject });
			runNext();
		});
	};
}

async function mapWithConcurrency(items, mapper, limit) {
	const limiter = createLimiter(limit);
	return Promise.all(
		items.map((item, idx) => limiter(() => mapper(item, idx))),
	);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

const tinybirdRateLimitState = {
	lastRequestTime: 0,
};

function createTinybirdRateLimiter(requestsPerSecond) {
	const minDelayMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
	return {
		minDelayMs,
		async wait() {
			const now = Date.now();
			const timeSinceLastRequest = now - tinybirdRateLimitState.lastRequestTime;
			if (timeSinceLastRequest < minDelayMs) {
				const waitTime = minDelayMs - timeSinceLastRequest;
				await sleep(waitTime);
			}
			tinybirdRateLimitState.lastRequestTime = Date.now();
		},
	};
}

const dubRateLimitState = {
	limit: 3000,
	remaining: 3000,
	resetAt: Date.now() + 60000,
	requests: [],
};

async function waitForRateLimit() {
	const state = dubRateLimitState;
	const now = Date.now();

	if (now >= state.resetAt) {
		state.remaining = state.limit;
		state.resetAt = now + 60000;
		state.requests = [];
	}

	state.requests = state.requests.filter(
		(timestamp) => timestamp > now - 60000,
	);

	if (state.requests.length >= state.limit) {
		const oldestRequest = Math.min(...state.requests);
		const waitTime = 60000 - (now - oldestRequest) + 100;
		if (waitTime > 0) {
			await sleep(waitTime);
			return waitForRateLimit();
		}
	}

	if (state.remaining <= 0) {
		const waitTime = state.resetAt - now + 100;
		if (waitTime > 0) {
			await sleep(waitTime);
			return waitForRateLimit();
		}
	}

	state.requests.push(now);
	if (state.remaining > 0) {
		state.remaining--;
	}
}

function updateRateLimitState(response) {
	const state = dubRateLimitState;
	const limitHeader = response.headers.get("x-ratelimit-limit");
	const remainingHeader = response.headers.get("x-ratelimit-remaining");
	const resetHeader = response.headers.get("x-ratelimit-reset");

	if (limitHeader) {
		const limit = Number(limitHeader);
		if (Number.isFinite(limit) && limit > 0) {
			state.limit = limit;
		}
	}

	if (remainingHeader) {
		const remaining = Number(remainingHeader);
		if (Number.isFinite(remaining) && remaining >= 0) {
			state.remaining = remaining;
		}
	}

	if (resetHeader) {
		const resetTimestamp = Number(resetHeader);
		if (Number.isFinite(resetTimestamp) && resetTimestamp > 0) {
			let resetMs;
			const now = Date.now();
			if (resetTimestamp > now * 1000) {
				resetMs = Math.floor(resetTimestamp / 1000);
			} else if (resetTimestamp > now) {
				resetMs = resetTimestamp;
			} else if (resetTimestamp < 1e10) {
				resetMs = resetTimestamp * 1000;
			} else {
				resetMs = Math.floor(resetTimestamp / 1000);
			}
			if (resetMs > now && resetMs < now + 86400000) {
				state.resetAt = resetMs;
			}
		}
	}
}

function normalizeDimensionField(value) {
	if (value === undefined || value === null) return "";
	const str = String(value).trim();
	if (!str || str === "*" || str === "null" || str === "undefined") return "";
	return str;
}

function resolveRegionName(region, regionCode, country) {
	const sources = [];
	if (region !== undefined) sources.push(region);
	if (regionCode !== undefined) sources.push(regionCode);
	const normalizedCountry = normalizeDimensionField(country).toUpperCase();
	if (normalizedCountry) {
		if (region) sources.push(`${normalizedCountry}-${region}`);
		if (regionCode) sources.push(`${normalizedCountry}-${regionCode}`);
	}
	for (const source of sources) {
		const normalized = normalizeDimensionField(source);
		if (!normalized) continue;
		if (REGIONS[normalized]) return REGIONS[normalized];
		const upper = normalized.toUpperCase();
		if (REGIONS[upper]) return REGIONS[upper];
	}
	const fallback =
		normalizeDimensionField(region) || normalizeDimensionField(regionCode);
	return fallback;
}

function resolveCountryCode(countryCode, country, continent) {
	const normalizedContinent = normalizeDimensionField(continent).toUpperCase();
	const normalizedCountryCode =
		normalizeDimensionField(countryCode).toUpperCase();
	const normalizedCountryName = normalizeDimensionField(country);
	const upperCountryName = normalizedCountryName
		? normalizedCountryName.toUpperCase()
		: "";

	if (normalizedCountryCode && COUNTRIES[normalizedCountryCode]) {
		if (normalizedContinent) {
			const expectedContinent = COUNTRIES_TO_CONTINENTS[normalizedCountryCode];
			if (expectedContinent && expectedContinent === normalizedContinent) {
				return normalizedCountryCode;
			}
		} else {
			return normalizedCountryCode;
		}
	}

	if (upperCountryName && COUNTRIES[upperCountryName]) {
		if (normalizedContinent) {
			const expectedContinent = COUNTRIES_TO_CONTINENTS[upperCountryName];
			if (expectedContinent && expectedContinent === normalizedContinent) {
				return upperCountryName;
			}
		} else {
			return upperCountryName;
		}
	}

	if (normalizedCountryName) {
		for (const [code, name] of Object.entries(COUNTRIES)) {
			if (
				name.toUpperCase() === upperCountryName ||
				name === normalizedCountryName
			) {
				if (normalizedContinent) {
					const expectedContinent = COUNTRIES_TO_CONTINENTS[code];
					if (expectedContinent && expectedContinent === normalizedContinent) {
						return code;
					}
				} else {
					return code;
				}
			}
		}
	}

	if (normalizedCountryCode && COUNTRIES[normalizedCountryCode]) {
		return normalizedCountryCode;
	}

	return normalizedCountryCode || upperCountryName || "";
}

async function dubFetch(pathname, token, params = {}) {
	const url = `${DUB_API_URL}${pathname}${Object.keys(params).length ? `?${qs(params)}` : ""}`;
	const maxAttempts = 5;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await waitForRateLimit();

		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		});

		updateRateLimitState(response);

		const text = await response.text();
		if (response.ok) {
			try {
				return JSON.parse(text || "{}");
			} catch {
				return {};
			}
		}
		const status = response.status;
		const shouldRetry = status === 429 || (status >= 500 && status < 600);
		if (!shouldRetry || attempt === maxAttempts) {
			let message = text;
			try {
				const payload = JSON.parse(text || "{}");
				message = payload?.error || payload?.message || text;
			} catch {}
			throw new Error(`Dub request failed (${status}): ${message}`);
		}
		const retryAfter = Number(response.headers.get("retry-after"));
		const base =
			Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: 500 * 2 ** (attempt - 1);
		const jitter = Math.floor(Math.random() * 250);
		await sleep(base + jitter);
	}
}

async function dubListLinks({ token, domain, limit = 100, offset = 0 }) {
	const params = {
		domain,
		limit,
		offset,
	};
	const res = await dubFetch("/links", token, params);
	const links = Array.isArray(res?.links)
		? res.links
		: Array.isArray(res)
			? res
			: [];
	const hasMore = res?.hasMore ?? false;
	return { links, hasMore };
}

async function dubFetchAllLinks({ token, domain, maxLinks = null }) {
	const allLinks = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const { links, hasMore } = await dubListLinks({
			token,
			domain,
			limit,
			offset,
		});
		allLinks.push(...links);
		offset += limit;

		if (maxLinks !== null && allLinks.length >= maxLinks) {
			return allLinks.slice(0, maxLinks);
		}

		if (links.length < limit) break;

		if (!hasMore && maxLinks === null) break;
	}

	return allLinks;
}

async function dubRetrieveTimeseries({
	token,
	domain,
	key,
	start,
	end,
	interval,
	timezone,
	city,
	country,
	region,
}) {
	const allRows = [];

	if (start && end) {
		const startDate = new Date(start);
		const endDate = new Date(end);
		const currentDate = new Date(startDate);

		while (currentDate <= endDate) {
			const dayStart = new Date(currentDate);
			dayStart.setHours(0, 0, 0, 0);
			const dayEnd = new Date(currentDate);
			dayEnd.setHours(23, 59, 59, 999);

			const dayStartISO = dayStart.toISOString();
			const dayEndISO = dayEnd.toISOString();

			const params = {
				event: "clicks",
				groupBy: "timeseries",
				domain,
				key,
				timezone: timezone || DEFAULT_TIMEZONE,
				interval: "24h",
				start: dayStartISO,
				end: dayEndISO,
				city: city || undefined,
				country: country || undefined,
				region: region || undefined,
			};

			const res = await dubFetch("/analytics", token, params);
			let data = [];
			if (Array.isArray(res)) {
				data = res;
			} else if (Array.isArray(res?.data)) {
				data = res.data;
			} else if (res && typeof res === "object") {
				data = [res];
			}

			for (const row of data) {
				if (!row || typeof row !== "object") continue;
				const t =
					row.start ||
					row.timestamp ||
					row.date ||
					row.ts ||
					row.time ||
					row.d ||
					row.t ||
					row.startDate;
				const c =
					row.count ?? row.clicks ?? row.value ?? row.total ?? row.n ?? 0;
				if (!t) continue;

				let tsStr;
				if (typeof t === "string") {
					tsStr = t;
				} else if (typeof t === "number") {
					tsStr = new Date(t).toISOString();
				} else {
					tsStr = String(t);
				}

				if (
					!tsStr ||
					tsStr === "undefined" ||
					tsStr === "null" ||
					tsStr === "Invalid Date"
				)
					continue;

				if (tsStr.includes("+0000")) {
					tsStr = tsStr.replace("+0000", "Z");
				} else if (tsStr.match(/[+-]\d{4}$/)) {
					const parsed = new Date(tsStr);
					if (!Number.isNaN(parsed.getTime())) {
						tsStr = parsed.toISOString();
					}
				} else if (!tsStr.includes("T") || !tsStr.includes(":")) {
					const parsed = new Date(tsStr);
					if (!Number.isNaN(parsed.getTime())) {
						tsStr = parsed.toISOString();
					}
				}

				const count = Number(c) || 0;
				if (count > 0) {
					allRows.push({ timestamp: tsStr, count });
				}
			}

			currentDate.setDate(currentDate.getDate() + 1);
		}
	} else {
		const params = {
			event: "clicks",
			groupBy: "timeseries",
			domain,
			key,
			timezone: timezone || DEFAULT_TIMEZONE,
			interval: interval || DEFAULT_INTERVAL,
			start: start || undefined,
			end: end || undefined,
			city: city || undefined,
			country: country || undefined,
			region: region || undefined,
		};
		const res = await dubFetch("/analytics", token, params);
		let data = [];
		if (Array.isArray(res)) {
			data = res;
		} else if (Array.isArray(res?.data)) {
			data = res.data;
		} else if (res && typeof res === "object") {
			data = [res];
		}

		for (const row of data) {
			if (!row || typeof row !== "object") continue;
			const t =
				row.start ||
				row.timestamp ||
				row.date ||
				row.ts ||
				row.time ||
				row.d ||
				row.t ||
				row.startDate;
			const c = row.count ?? row.clicks ?? row.value ?? row.total ?? row.n ?? 0;
			if (!t) continue;

			let tsStr;
			if (typeof t === "string") {
				tsStr = t;
			} else if (typeof t === "number") {
				tsStr = new Date(t).toISOString();
			} else {
				tsStr = String(t);
			}

			if (
				!tsStr ||
				tsStr === "undefined" ||
				tsStr === "null" ||
				tsStr === "Invalid Date"
			)
				continue;

			if (tsStr.includes("+0000")) {
				tsStr = tsStr.replace("+0000", "Z");
			} else if (tsStr.match(/[+-]\d{4}$/)) {
				const parsed = new Date(tsStr);
				if (!Number.isNaN(parsed.getTime())) {
					tsStr = parsed.toISOString();
				}
			} else if (!tsStr.includes("T") || !tsStr.includes(":")) {
				const parsed = new Date(tsStr);
				if (!Number.isNaN(parsed.getTime())) {
					tsStr = parsed.toISOString();
				}
			}

			const count = Number(c) || 0;
			if (count > 0) {
				allRows.push({ timestamp: tsStr, count });
			}
		}
	}

	return allRows.filter(
		(r) => r.timestamp && r.timestamp !== "undefined" && r.timestamp !== "null",
	);
}

async function dubRetrieveBreakdown({
	token,
	domain,
	key,
	start,
	end,
	interval,
	timezone,
	groupBy,
	city,
	country,
	region,
}) {
	const params = {
		event: "clicks",
		groupBy,
		domain,
		key,
		timezone: timezone || DEFAULT_TIMEZONE,
		interval: start || end ? undefined : interval || DEFAULT_INTERVAL,
		start: start || undefined,
		end: end || undefined,
		city: city || undefined,
		country: country || undefined,
		region: region || undefined,
	};
	const res = await dubFetch("/analytics", token, params);
	const data = Array.isArray(res?.data) ? res.data : res;
	const rows = Array.isArray(data) ? data : [];
	const normalized = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const name = normalizeDimensionField(
			row.name ??
				row.city ??
				row.country ??
				row.region ??
				row.device ??
				row.browser ??
				row.os ??
				row.key,
		);
		if (!name) continue;
		const value =
			Number(row.count ?? row.clicks ?? row.value ?? row.total ?? row.n ?? 0) ||
			0;
		const rowCity = normalizeDimensionField(row.city);
		const rowCountry =
			normalizeDimensionField(row.country) ||
			normalizeDimensionField(row.countryCode) ||
			normalizeDimensionField(row.country_code);
		const rowRegion =
			normalizeDimensionField(row.region) ||
			normalizeDimensionField(row.regionCode) ||
			normalizeDimensionField(row.region_code) ||
			normalizeDimensionField(row.state);
		const countryCode =
			normalizeDimensionField(row.countryCode) ||
			normalizeDimensionField(row.country_code) ||
			normalizeDimensionField(row.isoCode) ||
			normalizeDimensionField(row.iso_code);
		const regionCode =
			normalizeDimensionField(row.regionCode) ||
			normalizeDimensionField(row.region_code) ||
			normalizeDimensionField(row.subdivisionCode) ||
			normalizeDimensionField(row.subdivision_code);
		normalized.push({
			name,
			value,
			city: rowCity,
			country: rowCountry,
			region: rowRegion,
			countryCode,
			regionCode,
		});
	}
	return normalized;
}

function dayMidpointIso(day) {
	if (!day || day === "undefined" || day === "null") return null;
	const dayStr = String(day);
	if (dayStr.length >= 10) {
		const datePart = dayStr.slice(0, 10);
		if (datePart.match(/^\d{4}-\d{2}-\d{2}$/)) {
			return `${datePart}T12:00:00.000Z`;
		}
	}
	try {
		const d = new Date(dayStr + "T00:00:00.000Z");
		if (!Number.isNaN(d.getTime())) {
			return d.toISOString().slice(0, 10) + "T12:00:00.000Z";
		}
	} catch {}
	return null;
}

function* generateSessionIds(prefix, count) {
	for (let i = 0; i < count; i++) {
		yield `${prefix}-${i}`;
	}
}

function toNdjson(rows) {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

async function tinybirdIngest({
	host,
	token,
	datasource,
	ndjson,
	rateLimiter,
}) {
	const maxAttempts = 5;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (rateLimiter) {
			await rateLimiter.wait();
		}
		const search = new URLSearchParams({ name: datasource, format: "ndjson" });
		const url = `${host.replace(/\/$/, "")}/v0/events?${search.toString()}`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				Accept: "application/json",
			},
			body: ndjson,
		});
		const text = await response.text();
		if (response.ok) {
			try {
				return text ? JSON.parse(text) : {};
			} catch {
				return {};
			}
		}
		const status = response.status;
		let responseData = null;
		try {
			responseData = text ? JSON.parse(text) : null;
		} catch {}

		if (
			status === 429 &&
			responseData &&
			(responseData.quarantined ||
				responseData.imported ||
				responseData.success)
		) {
			return responseData;
		}

		const shouldRetry = status === 429 || (status >= 500 && status < 600);
		if (!shouldRetry || attempt === maxAttempts) {
			let message = text;
			if (responseData) {
				message = responseData?.error || responseData?.message || text;
			}
			throw new Error(`Tinybird ingest failed (${status}): ${message}`);
		}
		const retryAfter = response.headers.get("retry-after");
		let waitTime;
		if (retryAfter) {
			const retryAfterNum = Number(retryAfter);
			if (Number.isFinite(retryAfterNum) && retryAfterNum > 0) {
				if (retryAfterNum < 86400) {
					waitTime = retryAfterNum * 1000;
				} else if (retryAfterNum < 86400000) {
					waitTime = retryAfterNum;
				} else {
					waitTime = 60000;
				}
				if (waitTime > 60000) {
					waitTime = 60000;
				}
			} else {
				waitTime = Math.min(500 * 2 ** (attempt - 1), 60000);
			}
		} else {
			waitTime = Math.min(500 * 2 ** (attempt - 1), 60000);
		}
		const jitter = Math.floor(Math.random() * 250);
		await sleep(Math.min(waitTime + jitter, 60000));
	}
}

async function migrateVideo({
	tokenDub,
	tb,
	domain,
	videoId,
	orgId = "",
	window,
	limits,
	dryRun,
	apiConcurrency,
}) {
	const pathname = `/s/${videoId}`;
	const baseArgs = {
		token: tokenDub,
		domain,
		key: videoId,
		timezone: window.timezone,
		start: window.start,
		end: window.end,
		interval: window.interval,
	};

	const apiLimit = createLimiter(apiConcurrency || DEFAULT_API_CONCURRENCY);

	const timeseries = await apiLimit(() => dubRetrieveTimeseries(baseArgs));

	if (timeseries.length === 0) {
		if (dryRun) {
			return {
				videoId,
				orgId,
				timeseriesPoints: 0,
				citiesConsidered: 0,
				plannedEvents: 0,
				sample: [],
			};
		}
		return { videoId, orgId, written: 0 };
	}

	const [countries, cities, browsers, devices, os] = await Promise.all([
		apiLimit(() => dubRetrieveBreakdown({ ...baseArgs, groupBy: "countries" })),
		apiLimit(() => dubRetrieveBreakdown({ ...baseArgs, groupBy: "cities" })),
		apiLimit(() => dubRetrieveBreakdown({ ...baseArgs, groupBy: "browsers" })),
		apiLimit(() => dubRetrieveBreakdown({ ...baseArgs, groupBy: "devices" })),
		apiLimit(() => dubRetrieveBreakdown({ ...baseArgs, groupBy: "os" })),
	]);

	const selectedCities = cities
		.filter((c) => c.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, limits.maxCities)
		.map((city) => {
			const resolvedRegion = resolveRegionName(
				city.region,
				city.regionCode,
				city.countryCode || city.country,
			);
			return resolvedRegion ? { ...city, region: resolvedRegion } : city;
		});
	const cityMetaMap = new Map(selectedCities.map((city) => [city.name, city]));

	if (dryRun && timeseries.length > 0) {
		console.log(`  Sample timeseries entries (showing first 5):`);
		timeseries.slice(0, 5).forEach((entry, idx) => {
			console.log(`    [${idx}]:`, JSON.stringify(entry));
		});
		if (countries.length > 0)
			console.log(`  Sample countries:`, JSON.stringify(countries.slice(0, 3)));
		if (browsers.length > 0)
			console.log(`  Sample browsers:`, JSON.stringify(browsers.slice(0, 3)));
	}

	const cityToCountryMap = new Map();
	const cityToCountryCodeMap = new Map();
	const cityToRegionMap = new Map();
	for (const city of selectedCities) {
		const resolvedCountryCode = resolveCountryCode(
			city.countryCode,
			city.country,
			city.continent ||
				(city.countryCode
					? COUNTRIES_TO_CONTINENTS[city.countryCode.toUpperCase()]
					: undefined),
		);
		if (resolvedCountryCode) {
			cityToCountryCodeMap.set(city.name, resolvedCountryCode);
			cityToCountryMap.set(
				city.name,
				COUNTRIES[resolvedCountryCode] || city.country || "",
			);
		} else if (city.country) {
			cityToCountryMap.set(city.name, city.country);
		}
		if (city.region) cityToRegionMap.set(city.name, city.region);
	}

	// Try to get country/region for cities by querying cities breakdown which might include country info
	// If that doesn't work, try filtering countries/regions by city
	const citiesMissingCountry = selectedCities.filter(
		(city) => !cityToCountryMap.has(city.name),
	);
	await mapWithConcurrency(
		citiesMissingCountry,
		async (city) => {
			const cityWithCountry = await apiLimit(() =>
				dubRetrieveBreakdown({
					...baseArgs,
					groupBy: "countries",
					city: city.name,
				}),
			);
			const validCountries = cityWithCountry.filter(
				(c) => c.name && c.name !== "*" && c.value > 0,
			);
			if (validCountries.length === 1) {
				const resolvedCountryCode = resolveCountryCode(
					validCountries[0].countryCode,
					validCountries[0].name,
					validCountries[0].continent ||
						(validCountries[0].countryCode
							? COUNTRIES_TO_CONTINENTS[
									validCountries[0].countryCode.toUpperCase()
								]
							: undefined),
				);
				if (resolvedCountryCode) {
					cityToCountryCodeMap.set(city.name, resolvedCountryCode);
					cityToCountryMap.set(
						city.name,
						COUNTRIES[resolvedCountryCode] || validCountries[0].name,
					);
				} else {
					cityToCountryMap.set(city.name, validCountries[0].name);
				}
			} else if (validCountries.length > 1) {
				const topCountry = validCountries.sort((a, b) => b.value - a.value)[0];
				const resolvedCountryCode = resolveCountryCode(
					topCountry.countryCode,
					topCountry.name,
					topCountry.continent ||
						(topCountry.countryCode
							? COUNTRIES_TO_CONTINENTS[topCountry.countryCode.toUpperCase()]
							: undefined),
				);
				if (resolvedCountryCode) {
					cityToCountryCodeMap.set(city.name, resolvedCountryCode);
					cityToCountryMap.set(
						city.name,
						COUNTRIES[resolvedCountryCode] || topCountry.name,
					);
				} else {
					cityToCountryMap.set(city.name, topCountry.name);
				}
			}
			const cityWithRegion = await apiLimit(() =>
				dubRetrieveBreakdown({
					...baseArgs,
					groupBy: "regions",
					city: city.name,
				}),
			);
			const validRegions = cityWithRegion.filter(
				(r) => r.name && r.name !== "*" && r.value > 0,
			);
			if (validRegions.length === 1) {
				const regionCountryCode =
					validRegions[0].countryCode ||
					validRegions[0].country ||
					city.country;
				const resolvedRegion = resolveRegionName(
					validRegions[0].region || validRegions[0].name,
					validRegions[0].regionCode,
					regionCountryCode,
				);
				if (resolvedRegion) cityToRegionMap.set(city.name, resolvedRegion);
				if (!cityToCountryCodeMap.has(city.name)) {
					const resolvedCountryCode = resolveCountryCode(
						validRegions[0].countryCode,
						validRegions[0].country || city.country,
						validRegions[0].continent ||
							(validRegions[0].countryCode
								? COUNTRIES_TO_CONTINENTS[
										validRegions[0].countryCode.toUpperCase()
									]
								: undefined),
					);
					if (resolvedCountryCode) {
						cityToCountryCodeMap.set(city.name, resolvedCountryCode);
						if (!cityToCountryMap.has(city.name)) {
							cityToCountryMap.set(
								city.name,
								COUNTRIES[resolvedCountryCode] ||
									validRegions[0].country ||
									city.country ||
									"",
							);
						}
					}
				}
			} else if (validRegions.length > 1) {
				const topRegion = validRegions.sort((a, b) => b.value - a.value)[0];
				const regionCountryCode =
					topRegion.countryCode || topRegion.country || city.country;
				const resolvedRegion = resolveRegionName(
					topRegion.region || topRegion.name,
					topRegion.regionCode,
					regionCountryCode,
				);
				if (resolvedRegion) cityToRegionMap.set(city.name, resolvedRegion);
				if (!cityToCountryCodeMap.has(city.name)) {
					const resolvedCountryCode = resolveCountryCode(
						topRegion.countryCode,
						topRegion.country || city.country,
						topRegion.continent ||
							(topRegion.countryCode
								? COUNTRIES_TO_CONTINENTS[topRegion.countryCode.toUpperCase()]
								: undefined),
					);
					if (resolvedCountryCode) {
						cityToCountryCodeMap.set(city.name, resolvedCountryCode);
						if (!cityToCountryMap.has(city.name)) {
							cityToCountryMap.set(
								city.name,
								COUNTRIES[resolvedCountryCode] ||
									topRegion.country ||
									city.country ||
									"",
							);
						}
					}
				}
			}
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);
	const citiesMissingRegion = selectedCities.filter(
		(city) => !cityToRegionMap.has(city.name),
	);
	await mapWithConcurrency(
		citiesMissingRegion,
		async (city) => {
			if (cityToRegionMap.has(city.name)) return;
			const cityWithRegion = await apiLimit(() =>
				dubRetrieveBreakdown({
					...baseArgs,
					groupBy: "regions",
					city: city.name,
				}),
			);
			const validRegions = cityWithRegion.filter(
				(r) => r.name && r.name !== "*" && r.value > 0,
			);
			if (validRegions.length === 1) {
				const regionCountryCode =
					validRegions[0].countryCode ||
					validRegions[0].country ||
					city.country;
				const resolvedRegion = resolveRegionName(
					validRegions[0].region || validRegions[0].name,
					validRegions[0].regionCode,
					regionCountryCode,
				);
				if (resolvedRegion) cityToRegionMap.set(city.name, resolvedRegion);
				if (!cityToCountryCodeMap.has(city.name)) {
					const resolvedCountryCode = resolveCountryCode(
						validRegions[0].countryCode,
						validRegions[0].country || city.country,
						validRegions[0].continent ||
							(validRegions[0].countryCode
								? COUNTRIES_TO_CONTINENTS[
										validRegions[0].countryCode.toUpperCase()
									]
								: undefined),
					);
					if (resolvedCountryCode) {
						cityToCountryCodeMap.set(city.name, resolvedCountryCode);
						if (!cityToCountryMap.has(city.name)) {
							cityToCountryMap.set(
								city.name,
								COUNTRIES[resolvedCountryCode] ||
									validRegions[0].country ||
									city.country ||
									"",
							);
						}
					}
				}
			} else if (validRegions.length > 1) {
				const topRegion = validRegions.sort((a, b) => b.value - a.value)[0];
				const regionCountryCode =
					topRegion.countryCode || topRegion.country || city.country;
				const resolvedRegion = resolveRegionName(
					topRegion.region || topRegion.name,
					topRegion.regionCode,
					regionCountryCode,
				);
				if (resolvedRegion) cityToRegionMap.set(city.name, resolvedRegion);
				if (!cityToCountryCodeMap.has(city.name)) {
					const resolvedCountryCode = resolveCountryCode(
						topRegion.countryCode,
						topRegion.country || city.country,
						topRegion.continent ||
							(topRegion.countryCode
								? COUNTRIES_TO_CONTINENTS[topRegion.countryCode.toUpperCase()]
								: undefined),
					);
					if (resolvedCountryCode) {
						cityToCountryCodeMap.set(city.name, resolvedCountryCode);
						if (!cityToCountryMap.has(city.name)) {
							cityToCountryMap.set(
								city.name,
								COUNTRIES[resolvedCountryCode] ||
									topRegion.country ||
									city.country ||
									"",
							);
						}
					}
				}
			}
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);

	// Fallback: if we have cities but no country mapping, try to match cities to countries from overall breakdown
	// by checking if city name appears in country-specific city breakdowns
	const unresolvedCountryCities = selectedCities.filter(
		(city) => !cityToCountryMap.has(city.name),
	);
	if (unresolvedCountryCities.length > 0 && countries.length > 0) {
		const topCountries = countries.slice(0, 10);
		const countryCitiesList = await mapWithConcurrency(
			topCountries,
			(country) =>
				apiLimit(() =>
					dubRetrieveBreakdown({
						...baseArgs,
						groupBy: "cities",
						country: country.name,
					}).then((rows) => ({ country, rows })),
				),
			apiConcurrency || DEFAULT_API_CONCURRENCY,
		);
		for (const { country, rows: countryCities } of countryCitiesList) {
			for (const city of unresolvedCountryCities) {
				if (cityToCountryMap.has(city.name)) continue;
				const matchingCity = countryCities.find(
					(c) => c.name === city.name || c.city === city.name,
				);
				if (matchingCity) {
					if (!cityToCountryCodeMap.has(city.name)) {
						const resolvedCountryCode = resolveCountryCode(
							matchingCity.countryCode,
							matchingCity.country || country.name,
							matchingCity.continent ||
								(matchingCity.countryCode
									? COUNTRIES_TO_CONTINENTS[
											matchingCity.countryCode.toUpperCase()
										]
									: undefined),
						);
						if (resolvedCountryCode) {
							cityToCountryCodeMap.set(city.name, resolvedCountryCode);
							cityToCountryMap.set(
								city.name,
								COUNTRIES[resolvedCountryCode] ||
									matchingCity.country ||
									country.name ||
									matchingCity.name,
							);
						} else {
							const resolvedCountry =
								matchingCity.country || country.name || matchingCity.name;
							if (resolvedCountry)
								cityToCountryMap.set(city.name, resolvedCountry);
						}
					} else if (!cityToCountryMap.has(city.name)) {
						const resolvedCountryCode = cityToCountryCodeMap.get(city.name);
						cityToCountryMap.set(
							city.name,
							COUNTRIES[resolvedCountryCode] ||
								matchingCity.country ||
								country.name ||
								matchingCity.name,
						);
					}
					if (
						!cityToRegionMap.has(city.name) &&
						(matchingCity.region || matchingCity.regionCode)
					) {
						const resolvedRegion = resolveRegionName(
							matchingCity.region || matchingCity.name,
							matchingCity.regionCode,
							matchingCity.countryCode || matchingCity.country || country.name,
						);
						if (resolvedRegion) cityToRegionMap.set(city.name, resolvedRegion);
					}
				}
			}
		}
	}

	const perCityTimeseries = new Map();
	await mapWithConcurrency(
		selectedCities,
		async (c) => {
			const series = await apiLimit(() =>
				dubRetrieveTimeseries({ ...baseArgs, city: c.name }),
			);
			perCityTimeseries.set(c.name, series);
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);

	const perBrowserTimeseries = new Map();
	const topBrowsers = browsers
		.filter((b) => b.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, 10);
	await mapWithConcurrency(
		topBrowsers,
		async (browser) => {
			const series = await apiLimit(() =>
				dubRetrieveTimeseries({ ...baseArgs, browser: browser.name }),
			);
			perBrowserTimeseries.set(browser.name, series);
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);

	const perDeviceTimeseries = new Map();
	const topDevices = devices
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, 5);
	await mapWithConcurrency(
		topDevices,
		async (device) => {
			const series = await apiLimit(() =>
				dubRetrieveTimeseries({ ...baseArgs, device: device.name }),
			);
			perDeviceTimeseries.set(device.name, series);
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);

	const perOSTimeseries = new Map();
	const topOS = os
		.filter((o) => o.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, 5);
	await mapWithConcurrency(
		topOS,
		async (osItem) => {
			const series = await apiLimit(() =>
				dubRetrieveTimeseries({ ...baseArgs, os: osItem.name }),
			);
			perOSTimeseries.set(osItem.name, series);
		},
		apiConcurrency || DEFAULT_API_CONCURRENCY,
	);

	// Build rows per-city per-day with browser/device/OS distribution
	const rows = [];
	const dayRowMap = new Map();
	for (const seriesItem of timeseries) {
		if (seriesItem.count <= 0) continue;
		const tsStr = String(seriesItem.timestamp);
		if (!tsStr || tsStr === "undefined" || tsStr === "null") continue;

		let parsedDate;
		let day;
		let tsIso;

		if (tsStr.includes("T") && tsStr.includes(":")) {
			parsedDate = new Date(tsStr);
			if (!Number.isNaN(parsedDate.getTime())) {
				day = parsedDate.toISOString().slice(0, 10);
				tsIso = `${day}T00:00:00.000Z`;
			} else {
				day = tsStr.slice(0, 10);
				tsIso = dayMidpointIso(day);
			}
		} else {
			day = tsStr.slice(0, 10);
			const dateStrWithUTC =
				tsStr.includes("Z") || tsStr.match(/[+-]\d{2}:?\d{2}$/)
					? tsStr
					: tsStr + "T00:00:00.000Z";
			parsedDate = new Date(dateStrWithUTC);
			if (!Number.isNaN(parsedDate.getTime())) {
				day = parsedDate.toISOString().slice(0, 10);
				tsIso = `${day}T00:00:00.000Z`;
			} else {
				tsIso = dayMidpointIso(day);
			}
		}

		if (!day || day.length < 10 || day === "undefined") continue;
		if (!tsIso) continue;
		const dayTotal = seriesItem.count;
		let dayData = dayRowMap.get(day);
		if (!dayData) {
			dayData = { total: dayTotal, rows: [] };
			dayRowMap.set(day, dayData);
		} else {
			dayData.total = Math.max(dayData.total, dayTotal);
		}
		const dayRows = dayData.rows;

		// Get browser/device/OS breakdowns for this day
		const dayBrowsers = [];
		for (const [browserName, browserSeries] of perBrowserTimeseries.entries()) {
			const dayEntry = browserSeries.find(
				(s) => String(s.timestamp).slice(0, 10) === day,
			);
			if (dayEntry && dayEntry.count > 0) {
				dayBrowsers.push({ name: browserName, count: dayEntry.count });
			}
		}
		dayBrowsers.sort((a, b) => b.count - a.count);
		const totalBrowserClicks = dayBrowsers.reduce((a, b) => a + b.count, 0);

		const dayDevices = [];
		for (const [deviceName, deviceSeries] of perDeviceTimeseries.entries()) {
			const dayEntry = deviceSeries.find(
				(s) => String(s.timestamp).slice(0, 10) === day,
			);
			if (dayEntry && dayEntry.count > 0) {
				dayDevices.push({ name: deviceName, count: dayEntry.count });
			}
		}
		dayDevices.sort((a, b) => b.count - a.count);

		const dayOS = [];
		for (const [osName, osSeries] of perOSTimeseries.entries()) {
			const dayEntry = osSeries.find(
				(s) => String(s.timestamp).slice(0, 10) === day,
			);
			if (dayEntry && dayEntry.count > 0) {
				dayOS.push({ name: osName, count: dayEntry.count });
			}
		}
		dayOS.sort((a, b) => b.count - a.count);

		let allocated = 0;
		for (const [cityName, citySeries] of perCityTimeseries.entries()) {
			const dayEntry = citySeries.find(
				(s) => String(s.timestamp).slice(0, 10) === day,
			);
			const cityCount = dayEntry?.count || 0;
			if (cityCount <= 0) continue;
			allocated += cityCount;

			const cityMeta = cityMetaMap.get(cityName);
			const resolvedCountryCode = cityToCountryCodeMap.get(cityName);
			let country = "";
			if (resolvedCountryCode && COUNTRIES[resolvedCountryCode]) {
				country = COUNTRIES[resolvedCountryCode];
			} else {
				const fallbackCountry =
					cityToCountryMap.get(cityName) || cityMeta?.country || "";
				if (fallbackCountry) {
					const fallbackCode = fallbackCountry.toUpperCase();
					if (COUNTRIES[fallbackCode]) {
						country = COUNTRIES[fallbackCode];
					} else {
						country = fallbackCountry;
					}
				}
			}
			const region = cityToRegionMap.get(cityName) || cityMeta?.region || "";

			// Distribute city clicks across browsers proportionally
			let browserAllocated = 0;
			for (const browser of dayBrowsers) {
				const browserProportion =
					totalBrowserClicks > 0 ? browser.count / totalBrowserClicks : 0;
				const browserAllocation = Math.round(cityCount * browserProportion);
				if (browserAllocation <= 0) continue;
				browserAllocated += browserAllocation;

				// For each browser allocation, use most common device/OS for that day
				const device = dayDevices[0]?.name || topDevices[0]?.name || "desktop";
				const os = dayOS[0]?.name || topOS[0]?.name || "unknown";

				const sidPrefix = `mig:${videoId}:${day}:${cityName}:${browser.name}`;
				for (const sid of generateSessionIds(sidPrefix, browserAllocation)) {
					dayRows.push({
						timestamp: tsIso,
						session_id: sid,
						tenant_id: orgId,
						action: "page_hit",
						version: "dub_migration_v1",
						pathname,
						video_id: videoId,
						country,
						region,
						city: cityName,
						browser: browser.name,
						device,
						os,
					});
				}
			}

			// Handle remainder for browsers (or if no browser data)
			const browserRemainder = cityCount - browserAllocated;
			if (browserRemainder > 0 || totalBrowserClicks === 0) {
				const defaultBrowser =
					dayBrowsers[0]?.name || topBrowsers[0]?.name || "unknown";
				const defaultDevice =
					dayDevices[0]?.name || topDevices[0]?.name || "desktop";
				const defaultOS = dayOS[0]?.name || topOS[0]?.name || "unknown";
				const sidPrefix = `mig:${videoId}:${day}:${cityName}:${defaultBrowser}`;
				for (const sid of generateSessionIds(sidPrefix, browserRemainder)) {
					dayRows.push({
						timestamp: tsIso,
						session_id: sid,
						tenant_id: orgId,
						action: "page_hit",
						version: "dub_migration_v1",
						pathname,
						video_id: videoId,
						country,
						region,
						city: cityName,
						browser: defaultBrowser,
						device: defaultDevice,
						os: defaultOS,
					});
				}
			}
		}

		// Handle remainder (uncategorized)
		const remainder = Math.max(0, dayTotal - allocated);
		if (remainder > 0) {
			const defaultCountry = countries[0]?.name || "";
			const defaultBrowser =
				dayBrowsers[0]?.name || topBrowsers[0]?.name || "unknown";
			const defaultDevice =
				dayDevices[0]?.name || topDevices[0]?.name || "desktop";
			const defaultOS = dayOS[0]?.name || topOS[0]?.name || "unknown";
			const sidPrefix = `mig:${videoId}:${day}:__uncategorized__`;
			for (const sid of generateSessionIds(sidPrefix, remainder)) {
				dayRows.push({
					timestamp: tsIso,
					session_id: sid,
					tenant_id: orgId,
					action: "page_hit",
					version: "dub_migration_v1",
					pathname,
					video_id: videoId,
					country: defaultCountry,
					region: "",
					city: "",
					browser: defaultBrowser,
					device: defaultDevice,
					os: defaultOS,
				});
			}
		}
	}

	for (const [day, { total: dayTotal, rows: dayRows }] of dayRowMap.entries()) {
		if (dayRows.length > dayTotal) {
			const excess = dayRows.length - dayTotal;
			console.log(
				`  Day ${day}: Capping rows from ${dayRows.length} to ${dayTotal} (removing ${excess} excess row(s))`,
			);
			dayRows.splice(dayTotal);
		}
		rows.push(...dayRows);
	}

	const totalPlanned = rows.length;

	const seen = new Map();
	const deduplicatedRows = [];
	for (const row of rows) {
		const key = `${row.timestamp}|${row.session_id}|${row.video_id}`;
		if (!seen.has(key)) {
			seen.set(key, true);
			deduplicatedRows.push(row);
		}
	}

	const duplicatesRemoved = totalPlanned - deduplicatedRows.length;
	if (duplicatesRemoved > 0) {
		console.log(
			`  Removed ${duplicatesRemoved} duplicate row(s) (${totalPlanned} -> ${deduplicatedRows.length})`,
		);
	}

	if (dryRun) {
		return {
			videoId,
			orgId,
			timeseriesPoints: timeseries.length,
			citiesConsidered: selectedCities.length,
			plannedEvents: deduplicatedRows.length,
			duplicatesRemoved,
			sample: deduplicatedRows.slice(0, Math.min(3, deduplicatedRows.length)),
		};
	}

	let written = 0;
	const chunkSize = limits.ingestChunkSize || INGEST_CHUNK_SIZE;
	const ingestConcurrency =
		limits.ingestConcurrency || DEFAULT_INGEST_CONCURRENCY;
	const ingestRateLimit = limits.ingestRateLimit || DEFAULT_INGEST_RATE_LIMIT;
	const rateLimiter = createTinybirdRateLimiter(ingestRateLimit);
	const chunks = [];
	for (let i = 0; i < deduplicatedRows.length; i += chunkSize) {
		chunks.push(deduplicatedRows.slice(i, i + chunkSize));
	}
	const ingestLimit = createLimiter(ingestConcurrency);
	const results = await Promise.all(
		chunks.map((chunk) =>
			ingestLimit(async () => {
				const ndjson = toNdjson(chunk);
				await tinybirdIngest({
					host: tb.host,
					token: tb.token,
					datasource: TB_DATASOURCE,
					ndjson,
					rateLimiter,
				});
				return chunk.length;
			}),
		),
	);
	written = results.reduce((a, b) => a + b, 0);

	return {
		videoId,
		orgId,
		written,
	};
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.dryRun && !args.apply)
		usageAndExit("Specify --apply to perform writes or omit to dry run");

	const dubToken = requireEnv("DUB_API_KEY");
	const tbToken = args.dryRun ? null : requireEnv("TINYBIRD_TOKEN");
	const tbHost = DEFAULT_HOST;

	let videoIds = [...args.videoIds];

	if (videoIds.length === 0) {
		console.log(`Fetching all links from domain: ${args.domain}...`);
		const links = await dubFetchAllLinks({
			token: dubToken,
			domain: args.domain,
			maxLinks: args.limit || null,
		});
		videoIds = links.map((link) => link.key || link.id).filter(Boolean);
		console.log(`Found ${videoIds.length} links total`);
	}

	if (videoIds.length === 0) {
		console.error("No video IDs found to migrate");
		process.exit(0);
	}

	const originalCount = videoIds.length;
	if (args.limit && args.limit > 0 && args.limit < videoIds.length) {
		videoIds = videoIds.slice(0, args.limit);
		console.log(
			`Limiting to ${args.limit} videos (out of ${originalCount} total)`,
		);
	} else if (args.limit && args.limit > 0) {
		console.log(
			`Limit of ${args.limit} specified, but only ${originalCount} videos found`,
		);
	}

	const map = loadVideoToOrgMap(args, videoIds);

	const window = {
		interval: args.start || args.end ? undefined : args.interval,
		start: args.start || undefined,
		end: args.end || undefined,
		timezone: args.timezone,
	};

	const limits = { maxCities: args.maxCities };
	const maxToProcess =
		args.limit && args.limit > 0
			? Math.min(args.limit, videoIds.length)
			: videoIds.length;
	console.log(
		`Processing ${maxToProcess} video(s) with video concurrency=${args.videoConcurrency}, API concurrency=${args.apiConcurrency}, ingest rate limit=${args.ingestRateLimit}/s...`,
	);
	const extendedLimits = {
		...limits,
		ingestChunkSize: args.ingestChunk,
		ingestConcurrency: args.ingestConcurrency,
		ingestRateLimit: args.ingestRateLimit,
	};
	const videoLimiter = createLimiter(args.videoConcurrency);
	const tasks = videoIds.slice(0, maxToProcess).map((videoId, idx) =>
		videoLimiter(async () => {
			const orgId = map.get(videoId) || "";
			console.log(`Migrating ${videoId}... (${idx + 1}/${maxToProcess})`);
			return migrateVideo({
				tokenDub: dubToken,
				tb: { host: tbHost, token: tbToken },
				domain: args.domain,
				videoId,
				orgId,
				window,
				limits: extendedLimits,
				dryRun: args.dryRun,
				apiConcurrency: args.apiConcurrency,
			});
		}),
	);
	const results = await Promise.all(tasks);

	const totalPlanned = results.reduce(
		(acc, r) => acc + (r.plannedEvents || 0),
		0,
	);
	const totalWritten = results.reduce((acc, r) => acc + (r.written || 0), 0);

	const summary = {
		mode: args.dryRun ? "dry-run" : "apply",
		videos: videoIds.length,
		totalPlanned,
		totalWritten,
		results,
	};
	console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
