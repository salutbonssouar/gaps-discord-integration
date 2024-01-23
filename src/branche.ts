interface Branche {
  name: string;
  average: number;
  subBranches: SubBranche[];
}

interface SubBranche {
  name: string;
  average: number;
  weight: string;
  exams: Exam[];
}

interface Exam {
  date: string;
  description: string;
  average: string;
  coefficient: string;
  grade: string;
}
