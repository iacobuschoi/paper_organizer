// 비밀번호를 새로 만든다(또는 PASSWORD 환경 변수 값을 쓴다). 해시만 DATA_DIR/auth.json 에 저장하고,
// 비밀번호는 이 한 번만 화면에 찍는다. 바꾸면 기존 로그인은 모두 끊긴다.
//   npm run set-password            → 새 비밀번호 생성
//   PASSWORD='...' npm run set-password
import os from 'node:os';
import path from 'node:path';
import { generatePassword, setPassword } from './auth.js';

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), 'lab', 'paper-organizer-data');
const pw = process.env.PASSWORD || generatePassword();
setPassword(DATA_DIR, pw);
console.log(`비밀번호를 저장했어요 (해시만): ${path.join(DATA_DIR, 'auth.json')}`);
if (!process.env.PASSWORD) console.log(`새 비밀번호: ${pw}`);
console.log('돌고 있는 서버에도 바로 반영돼요. 기존 로그인은 모두 끊겼어요.');
