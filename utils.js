// LocalStorage 的辅助函数
const WRONG_SET_KEY = 'marxism_wrong_set';

function getWrongSet() {
    try {
        const data = localStorage.getItem(WRONG_SET_KEY);
        if (!data) return [];
        const parsedData = JSON.parse(data);
        return parsedData.map(item => (Array.isArray(item) ? {question: item, consecutiveCorrect: 0} : item));
    } catch (e) {
        console.error("无法从 localStorage 解析错题集", e);
        return [];
    }
}

function saveWrongSet(set) {
    localStorage.setItem(WRONG_SET_KEY, JSON.stringify(set));
    document.dispatchEvent(new CustomEvent('wrongset-updated'));
}

function addQuestionToWrongSet(originalQuestionArray) {
    const wrongSet = getWrongSet();
    const questionText = originalQuestionArray[0];
    const itemIndex = wrongSet.findIndex(item => item.question[0] === questionText);

    if (itemIndex === -1) {
        wrongSet.push({question: originalQuestionArray, consecutiveCorrect: 0});
    } else {
        wrongSet[itemIndex].consecutiveCorrect = 0;
    }
    saveWrongSet(wrongSet);
}


function parseQuestion(qArray) {
    if (!Array.isArray(qArray) || qArray.length < 2) return null;
    const cleanArray = qArray.filter(item => typeof item === 'string' && item.trim() !== '');
    if (cleanArray.length < 2) return null;

    const questionText = cleanArray[0];
    const answerLine = cleanArray.find(line => line.startsWith('正确答案:'));
    if (!questionText || !answerLine) return null;

    const answerIndex = cleanArray.indexOf(answerLine);
    let options = cleanArray.slice(1, answerIndex);
    let correctAnswer = answerLine.split(':')[1]?.trim();
    if (!correctAnswer) return null;

    const isMulti = questionText.includes('(多选题)');
    const isJudge = questionText.includes('(判断题)');
    let type = 'single';
    if (isMulti) type = 'multiple';
    if (isJudge) type = 'judge';

    if (type === 'judge') {
        if (correctAnswer === '对') correctAnswer = 'A';
        if (correctAnswer === '错') correctAnswer = 'B';
    }

    if (type === 'judge' && options.length === 0) {
        options.push('A. 对', 'B. 错');
    }

    const finalOptions = options.filter(opt => /^[A-Z]\./.test(opt.trim()));
    if (finalOptions.length === 0 && type !== 'judge') return null;

    return {
        question: questionText,
        options: finalOptions.length > 0 ? finalOptions : options,
        type: type,
        correctAnswer: correctAnswer,
        originalData: qArray
    };
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 刷题逻辑的核心工厂函数
function createBrushLogic(isWrongSetMode = false) {
    return {
        practicePool: [],
        currentQuestionIndex: -1,
        currentQuestion: null,
        userSelection: null,
        isPracticeStarted: false,
        isAnswerChecked: false,
        isCorrect: false,
        stats: {correct: 0, incorrect: 0, total: 0},
        autoNextTimeout: null,
        counts: {single: 0, multiple: 0, judge: 0, total: 0},
        isEmpty: true,
        // 用于存储每道题的作答状态
        answerHistory: {},

        get displayQuestionText() {
            if (!this.currentQuestion) return '';
            const questionWithoutOldNumber = this.currentQuestion.question.replace(/^\d+\.\s*/, '');
            return `${this.currentQuestionIndex + 1}. ${questionWithoutOldNumber}`;
        },

        get sectionTitle() {
            if (!this.currentQuestion) return '';
            switch (this.currentQuestion.type) {
                case 'single':
                    return '--- 第一部分：单选题 ---';
                case 'multiple':
                    return '--- 第二部分：多选题 ---';
                case 'judge':
                    return '--- 第三部分：判断题 ---';
                default:
                    return '';
            }
        },

        init(allParsedQuestions = null) {
            this.allQuestions = allParsedQuestions || [];
            if (isWrongSetMode) {
                this.checkWrongSetCounts();
            }
        },

        reset() {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);
            this.isPracticeStarted = false;
            this.currentQuestion = null;
            this.answerHistory = {}; // 重置时清空历史
            if (isWrongSetMode) {
                this.checkWrongSetCounts();
            }
        },

        checkWrongSetCounts() {
            if (!isWrongSetMode) return;
            const wrongSet = getWrongSet().map(item => parseQuestion(item.question)).filter(q => q !== null);
            this.allQuestions = wrongSet;
            this.counts.single = wrongSet.filter(q => q.type === 'single').length;
            this.counts.multiple = wrongSet.filter(q => q.type === 'multiple').length;
            this.counts.judge = wrongSet.filter(q => q.type === 'judge').length;
            this.counts.total = wrongSet.length;
            this.isEmpty = this.counts.total === 0;
        },

        startPracticeByType(type) {
            if (isWrongSetMode) this.checkWrongSetCounts();
            let source = this.allQuestions;

            if (type === 'all') {
                const singles = source.filter(q => q.type === 'single');
                const multiples = source.filter(q => q.type === 'multiple');
                const judges = source.filter(q => q.type === 'judge');
                this.practicePool = [...shuffleArray(singles), ...shuffleArray(multiples), ...shuffleArray(judges)];
            } else {
                this.practicePool = shuffleArray(source.filter(q => q.type === type));
            }

            this.stats.total = this.practicePool.length;
            if (this.stats.total > 0) {
                this.startPractice();
            }
        },

        startPractice() {
            this.isPracticeStarted = true;
            this.currentQuestionIndex = -1;
            this.stats.correct = 0;
            this.stats.incorrect = 0;
            this.answerHistory = {};
            this.loadQuestion(0);
        },

        loadQuestion(index) {
            if (this.autoNextTimeout) clearTimeout(this.autoNextTimeout);

            this.currentQuestionIndex = index;

            if (index < 0 || index >= this.practicePool.length) {
                this.currentQuestion = null;
                // 如果是超出最后一题，则判断为练习完成
                if (index >= this.practicePool.length && this.isPracticeStarted) {
                    this.isPracticeStarted = false; // 标记练习结束
                    // 需要一个变量来显示结束画面，我们暂时先让currentQuestion为null
                }
                return;
            }

            this.currentQuestion = this.practicePool[index];

            // 恢复历史作答状态
            const history = this.answerHistory[index];
            if (history) {
                this.isAnswerChecked = true;
                this.isCorrect = history.isCorrect;
                this.userSelection = history.userSelection;
            } else {
                this.isAnswerChecked = false;
                this.isCorrect = false;
                this.userSelection = this.currentQuestion.type === 'multiple' ? [] : '';
            }
        },

        prevQuestion() {
            if (this.currentQuestionIndex > 0) {
                this.loadQuestion(this.currentQuestionIndex - 1);
            }
        },

        nextQuestion() {
            if (this.currentQuestionIndex < this.practicePool.length - 1) {
                this.loadQuestion(this.currentQuestionIndex + 1);
            } else {
                // 最后一题，显示完成界面
                this.currentQuestion = null;
            }
        },

        selectAndCheck(selection) {
            if (this.isAnswerChecked) return;
            this.userSelection = selection;
            this.checkAnswer(true);
        },

        checkAnswer(isAutoCheck = false) {
            if (!this.currentQuestion || this.isAnswerChecked) return;
            if (this.currentQuestion.type === 'multiple' && this.userSelection.length === 0) {
                alert('请选择答案。');
                return;
            }
            this.isAnswerChecked = true;
            let isCorrect;
            if (this.currentQuestion.type === 'multiple') {
                const userAnswerSorted = this.userSelection.sort().join('');
                const correctAnswerSorted = [...this.currentQuestion.correctAnswer].sort().join('');
                isCorrect = userAnswerSorted === correctAnswerSorted;
            } else {
                isCorrect = this.userSelection === this.currentQuestion.correctAnswer;
            }
            this.isCorrect = isCorrect;

            // 记录到历史，并更新统计
            if (!this.answerHistory[this.currentQuestionIndex]) {
                if (isCorrect) {
                    this.stats.correct++;
                } else {
                    this.stats.incorrect++;
                }

                // 错题本逻辑
                if (isWrongSetMode) {
                    const wrongSet = getWrongSet();
                    const itemIndex = wrongSet.findIndex(item => item.question[0] === this.currentQuestion.question);
                    if (itemIndex > -1) {
                        if (isCorrect) {
                            wrongSet[itemIndex].consecutiveCorrect++;
                            if (wrongSet[itemIndex].consecutiveCorrect >= 3) {
                                wrongSet.splice(itemIndex, 1);
                            }
                        } else {
                            wrongSet[itemIndex].consecutiveCorrect = 0;
                        }
                        saveWrongSet(wrongSet);
                    }
                } else {
                    if (!isCorrect) {
                        addQuestionToWrongSet(this.currentQuestion.originalData);
                    }
                }
            }

            this.answerHistory[this.currentQuestionIndex] = {
                userSelection: this.userSelection,
                isCorrect: this.isCorrect
            };


            if (isAutoCheck && this.currentQuestion.type !== 'multiple') {
                this.autoNextTimeout = setTimeout(() => this.nextQuestion(), 1200);
            }
        },

        getOptionClass(option) {
            if (!this.isAnswerChecked) return 'border-base-300';
            const optionChar = option.charAt(0);
            const isCorrectAnswer = this.currentQuestion.correctAnswer.includes(optionChar);
            let isSelected = false;
            if (this.currentQuestion.type === 'multiple') {
                isSelected = this.userSelection.includes(optionChar);
            } else {
                isSelected = this.userSelection === optionChar;
            }
            if (isCorrectAnswer) return 'text-green-500 font-semibold border-green-500 bg-green-500/10';
            if (isSelected && !isCorrectAnswer) return 'text-red-500 border-red-500 bg-red-500/10';
            return 'border-base-300';
        },
    }
}

document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        mode: 'view',
        chapters: window.answer || [],
        allParsedQuestions: [],
        wrongQuestionCount: 0,
        brush: {},
        wrongBrush: {},

        init() {
            this.allParsedQuestions = window.answer.flatMap(ch => ch.list)
                .map(q => parseQuestion(q))
                .filter(q => q !== null);

            this.brush = createBrushLogic(false);
            this.wrongBrush = createBrushLogic(true);

            this.brush.init(this.allParsedQuestions);
            this.wrongBrush.init();

            this.updateWrongCount();
            document.addEventListener('wrongset-updated', () => {
                this.updateWrongCount();
                this.wrongBrush.checkWrongSetCounts();
            });
        },

        updateWrongCount() {
            this.wrongQuestionCount = getWrongSet().length;
        },

        setMode(newMode) {
            this.mode = newMode;
            if (newMode === 'brush') {
                this.brush.reset();
            } else if (newMode === 'wrong') {
                this.wrongBrush.reset();
            }
        },

        isHighlight(option, ans) {
            if (!ans || !ans.includes(':')) return false;
            let ansChar = ans.split(":")[1].trim();
            if (ansChar === '对') ansChar = 'A';
            if (ansChar === '错') ansChar = 'B';
            const optionChar = option.charAt(0);
            return ansChar.includes(optionChar);
        },
    }));
});