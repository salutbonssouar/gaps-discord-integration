import axios from "axios";
import fs from "fs";
import { JSDOM } from "jsdom";

const webhookId = process.env.WEBHOOK_ID || "";
const webhookToken = process.env.WEBHOOK_TOKEN || "";

const baseUrl = "https://gaps.heig-vd.ch";
const login: string = process.env.GAPS_LOGIN || "";
const password: string = process.env.GAPS_PASSWORD || "";

const GAPSSESSID_REGEX = /^GAPSSESSID=(.+?);/;
const DEFAULT_STUDENT_ID_REGEX = /DEFAULT_STUDENT_ID\s*=\s*(\d+);/;

checkVariable(webhookId, "WEBHOOK_ID");
checkVariable(webhookToken, "WEBHOOK_TOKEN");
checkVariable(login, "GAPS_LOGIN");
checkVariable(password, "GAPS_PASSWORD");

//TODO CHANGE NAME
retrieveAndLogId();

async function retrieveAndLogId() {
  try {
    const cookie = await getCookie();
    if (!cookie) {
      throw new Error("Cookie is empty.");
    }

    const id = await getId(cookie);
    if (id === -1) {
      throw new Error("Id is empty.");
    }

    const grades: string = (await getGrades(cookie, id))
      .replace(/\n/g, "")
      .replace(/\s+/g, " ")
      .replace(/^\+:/, "")
      .replace(/^\"+|\"+$/g, "")
      .replace(/\\/g, "");

    const branches: Branche[] = parseGrade(grades);

    if (fs.existsSync("grades.json")) {
      const json = fs.readFileSync("grades.json", "utf8");
      const localBranches: Branche[] = JSON.parse(json);

      const change: [boolean, boolean, [Branche, SubBranche, Exam]?] =
        compareBranches(branches, localBranches);

      if (change[0]) {
        fs.writeFileSync("grades.json", JSON.stringify(branches, null, 2));
      }
      if (change[1] && change[2]) {
        if (change[2][2].average !== "-") {
          sendDiscordMessage(
            change[2][0].name,
            change[2][1].name,
            change[2][2].date,
            change[2][2].average
          );
        }
      }
    } else {
      fs.writeFileSync("grades.json", JSON.stringify(branches, null, 2));
    }
  } catch (error) {
    console.error(error);
  }
}

async function getCookie(): Promise<string> {
  const response = await axios.post(
    `${baseUrl}/consultation/index.php`,
    new URLSearchParams({
      login: login,
      password: password,
      submit: "Enter",
    }),
    {
      withCredentials: true,
    }
  );

  const cookies = response.headers["set-cookie"];
  if (cookies && cookies.length === 2) {
    return cookies[1].match(new RegExp(GAPSSESSID_REGEX))?.[1] || "";
  }
  throw new Error(
    "An error occured during the login process. Your credentials may be wrong."
  );
}

async function getId(cookie: string): Promise<number> {
  const response = await axios.get(`${baseUrl}/consultation/etudiant/`, {
    headers: {
      Cookie: `GAPSSESSID=${cookie}`,
    },
  });

  return response.data.match(new RegExp(DEFAULT_STUDENT_ID_REGEX))?.[1] || -1;
}

async function getGrades(cookie: string, id: number): Promise<string> {
  const response = await axios.get(
    `${baseUrl}/consultation/controlescontinus/consultation.php`,
    {
      params: {
        rs: "getStudentCCs",
        rsargs: JSON.stringify([id, "2023"]),
      },
      headers: {
        Cookie: `GAPSSESSID=${cookie}`,
      },
    }
  );
  return response.data;
}

function parseGrade(grades: string): Branche[] {
  const parsedGrades = new JSDOM(grades).window.document;
  const branches: Branche[] = [];

  const rows = parsedGrades.querySelectorAll("tr");

  rows.forEach((row) => {
    const cells = row.cells;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const cellContent = cell.textContent || "";

      if (cell.classList.contains("bigheader")) {
        const [branchName, average] = cellContent.split(" - ");
        branches.push({
          name: branchName,
          average: parseFloat(average.split(" : ")[1]),
          subBranches: [],
        });
      } else if (
        cell.classList.contains("odd") ||
        cell.classList.contains("edge")
      ) {
        const [subBranchName, average, weight] = cellContent.split(" : ");
        branches[branches.length - 1].subBranches.push({
          name: subBranchName.split("moyenne")[0],
          average: parseFloat(average),
          weight: weight,
          exams: [],
        });
        i += 5;
      } else {
        branches[branches.length - 1].subBranches[
          branches[branches.length - 1].subBranches.length - 1
        ].exams.push({
          date: cells[i++].textContent || "-",
          description: cells[i++].textContent || "-",
          average: cells[i++].textContent || "-",
          coefficient: cells[i++].textContent || "-",
          grade: cells[i++].textContent || "-",
        });
      }
    }
  });
  return branches;
}

function compareBranches(
  branches: Branche[],
  localBranches: Branche[]
): [boolean, boolean, [Branche, SubBranche, Exam]?] {
  for (const branche of branches) {
    for (const subBranche of branche.subBranches) {
      for (const exam of subBranche.exams) {
        const localBranche = localBranches.find((b) => b.name === branche.name);
        if (!localBranche) {
          console.log(`Branche ${branche.name} has been added`);
          return [true, false];
        }

        const localSubBranche = localBranche.subBranches.find(
          (sb) => sb.name === subBranche.name
        );
        if (!localSubBranche) {
          console.log(
            `SubBranche ${subBranche.name} in Branche ${branche.name} has been added`
          );
          return [true, false];
        }

        const localExam = localSubBranche.exams.find(
          (e) => e.date === exam.date && e.description === exam.description
        );
        if (!localExam) {
          console.log(
            `Exam ${exam.description} on date ${exam.date} in SubBranche ${subBranche.name} of Branche ${branche.name} has been added`
          );
          return [true, true, [branche, subBranche, exam]];
        }

        if (JSON.stringify(exam) !== JSON.stringify(localExam)) {
          console.log(
            `Exam ${exam.description} on date ${exam.date} in SubBranche ${subBranche.name} of Branche ${branche.name} has been modified`
          );
          return [true, true, [branche, subBranche, exam]];
        }
      }
    }
  }
  return [false, false];
}

function sendDiscordMessage(
  name: string,
  description: string,
  date: string,
  average: string
): void {
  const formatedAverage = parseFloat(average);
  const emoji =
    formatedAverage >= 5 ? "✨" : formatedAverage >= 4 ? "👍" : "😬";

  axios.post(
    `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}?wait=true`,
    {
      content: null,
      embeds: [
        {
          title: "🚨 Une nouvelle note a été ajoutée 🚨",
          description: `${name}, "${description}" - ${date}\n\nMoyenne: ${average} ${emoji}`,
          url: "https://gaps.heig-vd.ch/consultation/controlescontinus/consultation.php",
          color: 16711680,
          timestamp: new Date().toISOString(),
        },
      ],
      username: "GAPS",
      avatar_url: "https://i.imgur.com/bmGBnNF.png",
      attachments: [],
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

function checkVariable(variable: string, name: string): void {
  if (!variable) {
    throw new Error(`${name} must be set as environment variable.`);
  }
}
